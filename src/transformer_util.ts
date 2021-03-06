/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ts from './typescript';
import {hasModifierFlag} from './util';

/**
 * Adjusts the given CustomTransformers with additional transformers
 * to fix bugs in TypeScript.
 */
export function createCustomTransformers(given: ts.CustomTransformers): ts.CustomTransformers {
  const before = given.before || [];
  before.unshift(addFileContexts);
  before.push(prepareNodesBeforeTypeScriptTransform);
  const after = given.after || [];
  after.unshift(emitMissingSyntheticCommentsAfterTypescriptTransform);
  return {before, after};
}

/**
 * A transformer that does nothing, but synthesizes all comments. This allows testing transformers
 * in isolation, but with an AST and comment placement that matches what'd happen after a source map
 * based transformer ran.
 */
export function synthesizeCommentsTransformer(context: ts.TransformationContext):
    ts.Transformer<ts.SourceFile> {
  return (sf: ts.SourceFile) => {
    function visitNodeRecursively(n: ts.Node): ts.Node {
      return visitEachChild(
          n, (n) => visitNodeWithSynthesizedComments(context, sf, n, visitNodeRecursively),
          context);
    }
    return visitNodeWithSynthesizedComments(context, sf, sf, visitNodeRecursively) as ts.SourceFile;
  };
}

/**
 * Transform that adds the FileContext to the TransformationContext.
 */
function addFileContexts(context: ts.TransformationContext) {
  return (sourceFile: ts.SourceFile) => {
    (context as TransformationContext).fileContext = new FileContext(sourceFile);
    return sourceFile;
  };
}

function assertFileContext(context: TransformationContext, sourceFile: ts.SourceFile): FileContext {
  if (!context.fileContext) {
    throw new Error(
        `Illegal State: FileContext not initialized. ` +
        `Did you forget to add the "firstTransform" as first transformer? ` +
        `File: ${sourceFile.fileName}`);
  }
  if (context.fileContext.file.fileName !== sourceFile.fileName) {
    throw new Error(
        `Illegal State: File of the FileContext does not match. File: ${sourceFile.fileName}`);
  }
  return context.fileContext;
}

/**
 * An extended version of the TransformationContext that stores the FileContext as well.
 */
interface TransformationContext extends ts.TransformationContext {
  fileContext?: FileContext;
}

/**
 * A context that stores information per file to e.g. allow communication
 * between transformers.
 * There is one ts.TransformationContext per emit,
 * but files are handled sequentially by all transformers. Thefore we can
 * store file related information on a property on the ts.TransformationContext,
 * given that we reset it in the first transformer.
 */
class FileContext {
  /**
   * Stores the parent node for all processed nodes.
   * This is needed for nodes from the parse tree that are used
   * in a synthetic node as must not modify these, even though they
   * have a new parent now.
   */
  syntheticNodeParents = new Map<ts.Node, ts.Node|undefined>();
  importOrReexportDeclarations: Array<ts.ExportDeclaration|ts.ImportDeclaration> = [];
  lastCommentEnd = -1;
  constructor(public file: ts.SourceFile) {}
}

/**
 * Transform that needs to be executed right before TypeScript's transform.
 *
 * This prepares the node tree to workaround some bugs in the TypeScript emitter.
 */
function prepareNodesBeforeTypeScriptTransform(context: ts.TransformationContext) {
  return (sourceFile: ts.SourceFile) => {
    const fileCtx = assertFileContext(context, sourceFile);

    const nodePath: ts.Node[] = [];
    visitNode(sourceFile);
    return sourceFile;

    function visitNode(node: ts.Node) {
      const parent = nodePath[nodePath.length - 1];

      if (node.flags & ts.NodeFlags.Synthesized) {
        // Set `parent` for synthetic nodes as well,
        // as otherwise the TS emit will crash for decorators.
        // Note: don't update the `parent` of original nodes, as:
        // 1) we don't want to change them at all
        // 2) TS emit becomes errorneous in some cases if we add a synthetic parent.
        // see https://github.com/Microsoft/TypeScript/issues/17384
        node.parent = parent;
      }
      fileCtx.syntheticNodeParents.set(node, parent);

      const originalNode = ts.getOriginalNode(node);

      if (node.kind === ts.SyntaxKind.ImportDeclaration ||
          node.kind === ts.SyntaxKind.ExportDeclaration) {
        const ied = node as ts.ImportDeclaration | ts.ExportDeclaration;
        if (ied.moduleSpecifier) {
          fileCtx.importOrReexportDeclarations.push(ied);
        }
      }

      // recurse
      nodePath.push(node);
      node.forEachChild(visitNode);
      nodePath.pop();
    }
  };
}

/**
 * Transform that needs to be executed after TypeScript's transform.
 *
 * This fixes places where the TypeScript transformer does not
 * emit synthetic comments.
 *
 * See https://github.com/Microsoft/TypeScript/issues/17594
 */
function emitMissingSyntheticCommentsAfterTypescriptTransform(context: ts.TransformationContext) {
  return (sourceFile: ts.SourceFile) => {
    const fileContext = assertFileContext(context, sourceFile);
    const nodePath: ts.Node[] = [];
    visitNode(sourceFile);
    (context as TransformationContext).fileContext = undefined;
    return sourceFile;

    function visitNode(node: ts.Node) {
      if (node.kind === ts.SyntaxKind.Identifier) {
        const parent1 = fileContext.syntheticNodeParents.get(node);
        const parent2 = parent1 && fileContext.syntheticNodeParents.get(parent1);
        const parent3 = parent2 && fileContext.syntheticNodeParents.get(parent2);

        if (parent1 && parent1.kind === ts.SyntaxKind.PropertyDeclaration) {
          // TypeScript ignores synthetic comments on (static) property declarations
          // with initializers.
          // find the parent ExpressionStatement like MyClass.foo = ...
          const expressionStmt =
              lastNodeWith(nodePath, (node) => node.kind === ts.SyntaxKind.ExpressionStatement);
          if (expressionStmt) {
            ts.setSyntheticLeadingComments(
                expressionStmt, ts.getSyntheticLeadingComments(parent1) || []);
          }
        } else if (
            parent3 && parent3.kind === ts.SyntaxKind.VariableStatement &&
            hasModifierFlag(parent3, ts.ModifierFlags.Export)) {
          // TypeScript ignores synthetic comments on exported variables.
          // find the parent ExpressionStatement like exports.foo = ...
          const expressionStmt =
              lastNodeWith(nodePath, (node) => node.kind === ts.SyntaxKind.ExpressionStatement);
          if (expressionStmt) {
            ts.setSyntheticLeadingComments(
                expressionStmt, ts.getSyntheticLeadingComments(parent3) || []);
          }
        }
      }
      // TypeScript ignores synthetic comments on reexport / import statements.
      // The code below re-adds them one the converted CommonJS import statements, and resets the
      // text range to prevent previous comments from being emitted.
      if (isCommonJsRequireStatement(node) && fileContext.importOrReexportDeclarations) {
        // Locate the original import/export declaration via the
        // text range.
        const importOrReexportDeclaration =
            fileContext.importOrReexportDeclarations.find(ied => ied.pos === node.pos);
        if (importOrReexportDeclaration) {
          ts.setSyntheticLeadingComments(
              node, ts.getSyntheticLeadingComments(importOrReexportDeclaration) || []);
        }
        // Need to clear the textRange for ImportDeclaration / ExportDeclaration as
        // otherwise TypeScript would emit the original comments even if we set the
        // ts.EmitFlag.NoComments. (see also resetNodeTextRangeToPreventDuplicateComments below)
        ts.setSourceMapRange(node, {pos: node.pos, end: node.end});
        ts.setTextRange(node, {pos: -1, end: -1});
      }
      nodePath.push(node);
      node.forEachChild(visitNode);
      nodePath.pop();
    }
  };
}

function isCommonJsRequireStatement(node: ts.Node): boolean {
  // CommonJS requires can be either "var x = require('...');" or (for side effect imports), just
  // "require('...');".
  let callExpr: ts.CallExpression;
  if (ts.isVariableStatement(node)) {
    const varStmt = node as ts.VariableStatement;
    const decls = varStmt.declarationList.declarations;
    let init: ts.Expression|undefined;
    if (decls.length !== 1 || !(init = decls[0].initializer) ||
        init.kind !== ts.SyntaxKind.CallExpression) {
      return false;
    }
    callExpr = init as ts.CallExpression;
  } else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    callExpr = node.expression;
  } else {
    return false;
  }
  if (callExpr.expression.kind !== ts.SyntaxKind.Identifier ||
      (callExpr.expression as ts.Identifier).text !== 'require' ||
      callExpr.arguments.length !== 1) {
    return false;
  }
  const moduleExpr = callExpr.arguments[0];
  return moduleExpr.kind === ts.SyntaxKind.StringLiteral;
}

function lastNodeWith(nodes: ts.Node[], predicate: (node: ts.Node) => boolean): ts.Node|null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (predicate(node)) {
      return node;
    }
  }
  return null;
}

/**
 * Convert comment text ranges before and after a node
 * into ts.SynthesizedComments for the node and prevent the
 * comment text ranges to be emitted, to allow
 * changing these comments.
 *
 * This function takes a visitor to be able to do some
 * state management after the caller is done changing a node.
 */
export function visitNodeWithSynthesizedComments<T extends ts.Node>(
    context: ts.TransformationContext, sourceFile: ts.SourceFile, node: T,
    visitor: (node: T) => T): T {
  if (node.flags & ts.NodeFlags.Synthesized) {
    return visitor(node);
  }
  if (node.kind === ts.SyntaxKind.Block) {
    const block = node as ts.Node as ts.Block;
    node = visitNodeStatementsWithSynthesizedComments(
        context, sourceFile, node, block.statements,
        (node, stmts) => visitor(ts.updateBlock(block, stmts) as ts.Node as T));
  } else if (node.kind === ts.SyntaxKind.SourceFile) {
    node = visitNodeStatementsWithSynthesizedComments(
        context, sourceFile, node, sourceFile.statements,
        (node, stmts) => visitor(updateSourceFileNode(sourceFile, stmts) as ts.Node as T));
  } else {
    // In arrow functions with expression bodies (`(x) => expr`), do not synthesize comment nodes
    // that precede the body expression. When downleveling to ES5, TypeScript inserts a return
    // statement and moves the comment in front of it, but then still emits any syntesized comment
    // we create here. That can cause a line comment to be emitted after the return, which causes
    // Automatic Semicolon Insertion, which then breaks the code. See arrow_fn_es5.ts for an
    // example.
    if (node.parent && (node as ts.Node).kind !== ts.SyntaxKind.Block &&
        ts.isArrowFunction(node.parent) && (node as ts.Node) === node.parent.body) {
      return visitor(node);
    }
    const fileContext = assertFileContext(context, sourceFile);
    const leadingLastCommentEnd =
        synthesizeLeadingComments(sourceFile, node, fileContext.lastCommentEnd);
    const trailingLastCommentEnd = synthesizeTrailingComments(sourceFile, node);
    if (leadingLastCommentEnd !== -1) {
      fileContext.lastCommentEnd = leadingLastCommentEnd;
    }
    node = visitor(node);
    if (trailingLastCommentEnd !== -1) {
      fileContext.lastCommentEnd = trailingLastCommentEnd;
    }
  }
  return resetNodeTextRangeToPreventDuplicateComments(node);
}

/**
 * Reset the text range for some special nodes as otherwise TypeScript
 * would always emit the original comments for them.
 * See https://github.com/Microsoft/TypeScript/issues/17594
 *
 * @param node
 */
function resetNodeTextRangeToPreventDuplicateComments<T extends ts.Node>(node: T): T {
  ts.setEmitFlags(node, (ts.getEmitFlags(node) || 0) | ts.EmitFlags.NoComments);
  // See also emitMissingSyntheticCommentsAfterTypescriptTransform.
  // Note: Don't reset the textRange for ts.ExportDeclaration / ts.ImportDeclaration
  // until after the TypeScript transformer as we need the source location
  // to map the generated `require` calls back to the original
  // ts.ExportDeclaration / ts.ImportDeclaration nodes.
  let allowTextRange = node.kind !== ts.SyntaxKind.ClassDeclaration &&
      node.kind !== ts.SyntaxKind.VariableDeclaration &&
      !(node.kind === ts.SyntaxKind.VariableStatement &&
        hasModifierFlag(node, ts.ModifierFlags.Export)) &&
      node.kind !== ts.SyntaxKind.ModuleDeclaration;
  if (node.kind === ts.SyntaxKind.PropertyDeclaration) {
    allowTextRange = false;
    const pd = node as ts.Node as ts.PropertyDeclaration;
    node = ts.updateProperty(
               pd, pd.decorators, pd.modifiers, resetTextRange(pd.name) as ts.PropertyName,
               pd.questionToken, pd.type, pd.initializer) as ts.Node as T;
  }
  if (!allowTextRange) {
    node = resetTextRange(node);
  }
  return node;

  function resetTextRange<T extends ts.Node>(node: T): T {
    if (!(node.flags & ts.NodeFlags.Synthesized)) {
      // need to clone as we don't want to modify source nodes,
      // as the parsed SourceFiles could be cached!
      node = ts.getMutableClone(node);
    }
    const textRange = {pos: node.pos, end: node.end};
    ts.setSourceMapRange(node, textRange);
    ts.setTextRange(node, {pos: -1, end: -1});
    return node;
  }
}

/**
 * Reads in the leading comment text ranges of the given node,
 * converts them into `ts.SyntheticComment`s and stores them on the node.
 *
 * Note: This would be greatly simplified with https://github.com/Microsoft/TypeScript/issues/17615.
 *
 * @param lastCommentEnd The end of the last comment
 * @return The end of the last found comment, -1 if no comment was found.
 */
function synthesizeLeadingComments(
    sourceFile: ts.SourceFile, node: ts.Node, lastCommentEnd: number): number {
  const parent = node.parent;
  const sharesStartWithParent = parent && parent.kind !== ts.SyntaxKind.Block &&
      parent.kind !== ts.SyntaxKind.SourceFile && parent.getFullStart() === node.getFullStart();
  if (sharesStartWithParent || lastCommentEnd >= node.getStart()) {
    return -1;
  }
  const adjustedNodeFullStart = Math.max(lastCommentEnd, node.getFullStart());
  const leadingComments =
      getAllLeadingCommentRanges(sourceFile, adjustedNodeFullStart, node.getStart());
  if (leadingComments && leadingComments.length) {
    ts.setSyntheticLeadingComments(node, synthesizeCommentRanges(sourceFile, leadingComments));
    return node.getStart();
  }
  return -1;
}

/**
 * Reads in the trailing comment text ranges of the given node,
 * converts them into `ts.SyntheticComment`s and stores them on the node.
 *
 * Note: This would be greatly simplified with https://github.com/Microsoft/TypeScript/issues/17615.
 *
 * @return The end of the last found comment, -1 if no comment was found.
 */
function synthesizeTrailingComments(sourceFile: ts.SourceFile, node: ts.Node): number {
  const parent = node.parent;
  const sharesEndWithParent = parent && parent.kind !== ts.SyntaxKind.Block &&
      parent.kind !== ts.SyntaxKind.SourceFile && parent.getEnd() === node.getEnd();
  if (sharesEndWithParent) {
    return -1;
  }
  const trailingComments = ts.getTrailingCommentRanges(sourceFile.text, node.getEnd());
  if (trailingComments && trailingComments.length) {
    ts.setSyntheticTrailingComments(node, synthesizeCommentRanges(sourceFile, trailingComments));
    return trailingComments[trailingComments.length - 1].end;
  }
  return -1;
}

function arrayOf<T>(value: T|undefined|null): T[] {
  return value ? [value] : [];
}

/**
 * Convert leading/trailing detached comment ranges of statement arrays
 * (e.g. the statements of a ts.SourceFile or ts.Block) into
 * `ts.NonEmittedStatement`s with `ts.SynthesizedComment`s and
 * prepends / appends them to the given statement array.
 * This is needed to allow changing these comments.
 *
 * This function takes a visitor to be able to do some
 * state management after the caller is done changing a node.
 */
function visitNodeStatementsWithSynthesizedComments<T extends ts.Node>(
    context: ts.TransformationContext, sourceFile: ts.SourceFile, node: T,
    statements: ts.NodeArray<ts.Statement>,
    visitor: (node: T, statements: ts.NodeArray<ts.Statement>) => T): T {
  const leading = synthesizeDetachedLeadingComments(sourceFile, node, statements);
  const trailing = synthesizeDetachedTrailingComments(sourceFile, node, statements);
  if (leading.commentStmt || trailing.commentStmt) {
    const newStatements: ts.Statement[] =
        [...arrayOf(leading.commentStmt), ...statements, ...arrayOf(trailing.commentStmt)];
    statements = ts.setTextRange(ts.createNodeArray(newStatements), {pos: -1, end: -1});

    /**
     * The visitor creates a new node with the new statements. However, doing so
     * reveals a TypeScript bug.
     * To reproduce comment out the line below and compile:
     *
     * // ......
     *
     * abstract class A {
     * }
     * abstract class B extends A {
     *   // ......
     * }
     *
     * Note that newlines are significant. This would result in the following:
     * runtime error "TypeError: Cannot read property 'members' of undefined".
     *
     * The line below is a workaround that ensures that updateSourceFileNode and
     * updateBlock never create new Nodes.
     * TODO(#634): file a bug with TS team.
     */
    (node as ts.Node as ts.SourceFile).statements = statements;

    const fileContext = assertFileContext(context, sourceFile);
    if (leading.lastCommentEnd !== -1) {
      fileContext.lastCommentEnd = leading.lastCommentEnd;
    }
    node = visitor(node, statements);
    if (trailing.lastCommentEnd !== -1) {
      fileContext.lastCommentEnd = trailing.lastCommentEnd;
    }
    return node;
  }
  return visitor(node, statements);
}

/**
 * Convert leading detached comment ranges of statement arrays
 * (e.g. the statements of a ts.SourceFile or ts.Block) into a
 * `ts.NonEmittedStatement` with `ts.SynthesizedComment`s.
 *
 * A Detached leading comment is the first comment in a SourceFile / Block
 * that is separated with a newline from the first statement.
 *
 * Note: This would be greatly simplified with https://github.com/Microsoft/TypeScript/issues/17615.
 */
function synthesizeDetachedLeadingComments(
    sourceFile: ts.SourceFile, node: ts.Node, statements: ts.NodeArray<ts.Statement>):
    {commentStmt: ts.Statement|null, lastCommentEnd: number} {
  let triviaEnd = statements.end;
  if (statements.length) {
    triviaEnd = statements[0].getStart();
  }
  const detachedComments = getDetachedLeadingCommentRanges(sourceFile, statements.pos, triviaEnd);
  if (!detachedComments.length) {
    return {commentStmt: null, lastCommentEnd: -1};
  }
  const lastCommentEnd = detachedComments[detachedComments.length - 1].end;
  const commentStmt = createNotEmittedStatement(sourceFile);
  ts.setSyntheticTrailingComments(
      commentStmt, synthesizeCommentRanges(sourceFile, detachedComments));
  return {commentStmt, lastCommentEnd};
}

/**
 * Convert trailing detached comment ranges of statement arrays
 * (e.g. the statements of a ts.SourceFile or ts.Block) into a
 * `ts.NonEmittedStatement` with `ts.SynthesizedComment`s.
 *
 * A Detached trailing comment are all comments after the first newline
 * the follows the last statement in a SourceFile / Block.
 *
 * Note: This would be greatly simplified with https://github.com/Microsoft/TypeScript/issues/17615.
 */
function synthesizeDetachedTrailingComments(
    sourceFile: ts.SourceFile, node: ts.Node, statements: ts.NodeArray<ts.Statement>):
    {commentStmt: ts.Statement|null, lastCommentEnd: number} {
  let trailingCommentStart = statements.end;
  if (statements.length) {
    const lastStmt = statements[statements.length - 1];
    const lastStmtTrailingComments = ts.getTrailingCommentRanges(sourceFile.text, lastStmt.end);
    if (lastStmtTrailingComments && lastStmtTrailingComments.length) {
      trailingCommentStart = lastStmtTrailingComments[lastStmtTrailingComments.length - 1].end;
    }
  }
  const detachedComments = getAllLeadingCommentRanges(sourceFile, trailingCommentStart, node.end);
  if (!detachedComments || !detachedComments.length) {
    return {commentStmt: null, lastCommentEnd: -1};
  }
  const lastCommentEnd = detachedComments[detachedComments.length - 1].end;
  const commentStmt = createNotEmittedStatement(sourceFile);
  ts.setSyntheticLeadingComments(
      commentStmt, synthesizeCommentRanges(sourceFile, detachedComments));
  return {commentStmt, lastCommentEnd};
}

/**
 * Calculates the the detached leading comment ranges in an area of a SourceFile.
 * @param sourceFile The source file
 * @param start Where to start scanning
 * @param end Where to end scanning
 */
// Note: This code is based on compiler/comments.ts in TypeScript
function getDetachedLeadingCommentRanges(
    sourceFile: ts.SourceFile, start: number, end: number): ts.CommentRange[] {
  const leadingComments = getAllLeadingCommentRanges(sourceFile, start, end);
  if (!leadingComments || !leadingComments.length) {
    return [];
  }
  const detachedComments: ts.CommentRange[] = [];
  let lastComment: ts.CommentRange|undefined = undefined;

  for (const comment of leadingComments) {
    if (lastComment) {
      const lastCommentLine = getLineOfPos(sourceFile, lastComment.end);
      const commentLine = getLineOfPos(sourceFile, comment.pos);

      if (commentLine >= lastCommentLine + 2) {
        // There was a blank line between the last comment and this comment.  This
        // comment is not part of the copyright comments.  Return what we have so
        // far.
        break;
      }
    }

    detachedComments.push(comment);
    lastComment = comment;
  }

  if (detachedComments.length) {
    // All comments look like they could have been part of the copyright header.  Make
    // sure there is at least one blank line between it and the node.  If not, it's not
    // a copyright header.
    const lastCommentLine =
        getLineOfPos(sourceFile, detachedComments[detachedComments.length - 1].end);
    const nodeLine = getLineOfPos(sourceFile, end);
    if (nodeLine >= lastCommentLine + 2) {
      // Valid detachedComments
      return detachedComments;
    }
  }
  return [];
}

function getLineOfPos(sourceFile: ts.SourceFile, pos: number): number {
  return ts.getLineAndCharacterOfPosition(sourceFile, pos).line;
}

/**
 * ts.createNotEmittedStatement will create a node whose comments are never emitted except for very
 * specific special cases (/// comments). createNotEmittedStatementWithComments creates a not
 * emitted statement and adds comment ranges from the original statement as synthetic comments to
 * it, so that they get retained in the output.
 */
export function createNotEmittedStatementWithComments(
    sourceFile: ts.SourceFile, original: ts.Node): ts.Statement {
  let replacement = ts.createNotEmittedStatement(original);
  // NB: synthetic nodes can have pos/end == -1. This is handled by the underlying implementation.
  const leading = ts.getLeadingCommentRanges(sourceFile.text, original.pos) || [];
  const trailing = ts.getTrailingCommentRanges(sourceFile.text, original.end) || [];
  replacement =
      ts.setSyntheticLeadingComments(replacement, synthesizeCommentRanges(sourceFile, leading));
  replacement =
      ts.setSyntheticTrailingComments(replacement, synthesizeCommentRanges(sourceFile, trailing));
  return replacement;
}

/**
 * Converts `ts.CommentRange`s into `ts.SynthesizedComment`s
 * @param sourceFile
 * @param parsedComments
 */
function synthesizeCommentRanges(
    sourceFile: ts.SourceFile, parsedComments: ts.CommentRange[]): ts.SynthesizedComment[] {
  const synthesizedComments: ts.SynthesizedComment[] = [];
  parsedComments.forEach(({kind, pos, end, hasTrailingNewLine}, commentIdx) => {
    let commentText = sourceFile.text.substring(pos, end).trim();
    if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      commentText = commentText.replace(/(^\/\*)|(\*\/$)/g, '');
    } else if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      if (commentText.startsWith('///')) {
        // tripple-slash comments are typescript specific, ignore them in the output.
        return;
      }
      commentText = commentText.replace(/(^\/\/)/g, '');
    }
    synthesizedComments.push({kind, text: commentText, hasTrailingNewLine, pos: -1, end: -1});
  });
  return synthesizedComments;
}

/**
 * Creates a non emitted statement that can be used to store synthesized comments.
 */
export function createNotEmittedStatement(sourceFile: ts.SourceFile): ts.NotEmittedStatement {
  const stmt = ts.createNotEmittedStatement(sourceFile);
  ts.setOriginalNode(stmt, undefined);
  ts.setTextRange(stmt, {pos: 0, end: 0});
  ts.setEmitFlags(stmt, ts.EmitFlags.CustomPrologue);
  return stmt;
}

/**
 * Returns the leading comment ranges in the source file that start at the given position.
 * This is the same as `ts.getLeadingCommentRanges`, except that it does not skip
 * comments before the first newline in the range.
 *
 * @param sourceFile
 * @param start Where to start scanning
 * @param end Where to end scanning
 */
function getAllLeadingCommentRanges(
    sourceFile: ts.SourceFile, start: number, end: number): ts.CommentRange[] {
  // exeute ts.getLeadingCommentRanges with pos = 0 so that it does not skip
  // comments until the first newline.
  const commentRanges = ts.getLeadingCommentRanges(sourceFile.text.substring(start, end), 0) || [];
  return commentRanges.map(cr => ({
                             hasTrailingNewLine: cr.hasTrailingNewLine,
                             kind: cr.kind as number,
                             pos: cr.pos + start,
                             end: cr.end + start
                           }));
}

/**
 * This is a version of `ts.visitEachChild` that works that calls our version
 * of `updateSourceFileNode`, so that typescript doesn't lose type information
 * for property decorators.
 * See https://github.com/Microsoft/TypeScript/issues/17384
 *
 * @param sf
 * @param statements
 */
export function visitEachChild(
    node: ts.Node, visitor: ts.Visitor, context: ts.TransformationContext): ts.Node {
  if (node.kind === ts.SyntaxKind.SourceFile) {
    const sf = node as ts.SourceFile;
    return updateSourceFileNode(sf, ts.visitLexicalEnvironment(sf.statements, visitor, context));
  }

  return ts.visitEachChild(node, visitor, context);
}

/**
 * This is a version of `ts.updateSourceFileNode` that works
 * well with property decorators.
 * See https://github.com/Microsoft/TypeScript/issues/17384
 * TODO(#634): This has been fixed in TS 2.5. Investigate removal.
 *
 * @param sf
 * @param statements
 */
export function updateSourceFileNode(
    sf: ts.SourceFile, statements: ts.NodeArray<ts.Statement>): ts.SourceFile {
  if (statements === sf.statements) {
    return sf;
  }
  // Note: Need to clone the original file (and not use `ts.updateSourceFileNode`)
  // as otherwise TS fails when resolving types for decorators.
  sf = ts.getMutableClone(sf);
  sf.statements = statements;
  return sf;
}

// Copied from TypeScript
export function isTypeNodeKind(kind: ts.SyntaxKind) {
  return (kind >= ts.SyntaxKind.FirstTypeNode && kind <= ts.SyntaxKind.LastTypeNode) ||
      kind === ts.SyntaxKind.AnyKeyword || kind === ts.SyntaxKind.NumberKeyword ||
      kind === ts.SyntaxKind.ObjectKeyword || kind === ts.SyntaxKind.BooleanKeyword ||
      kind === ts.SyntaxKind.StringKeyword || kind === ts.SyntaxKind.SymbolKeyword ||
      kind === ts.SyntaxKind.ThisKeyword || kind === ts.SyntaxKind.VoidKeyword ||
      kind === ts.SyntaxKind.UndefinedKeyword || kind === ts.SyntaxKind.NullKeyword ||
      kind === ts.SyntaxKind.NeverKeyword || kind === ts.SyntaxKind.ExpressionWithTypeArguments;
}

/**
 * Creates a string literal that uses single quotes. Purely cosmetic, but increases fidelity to the
 * existing test suite.
 */
export function createSingleQuoteStringLiteral(text: string): ts.StringLiteral {
  const stringLiteral = ts.createLiteral(text);
  // tslint:disable-next-line:no-any accessing TS internal API.
  (stringLiteral as any).singleQuote = true;
  return stringLiteral;
}
