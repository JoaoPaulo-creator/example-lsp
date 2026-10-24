import ts from 'typescript';
import { CompletionItemKind, SymbolKind } from 'vscode-languageserver/node';

const E = ts.ScriptElementKind;

export function toCompletionItemKind(kind: ts.ScriptElementKind): CompletionItemKind {
  switch (kind) {
    case E.primitiveType:
    case E.keyword:
      return CompletionItemKind.Keyword;
    case E.constElement:
    case E.letElement:
    case E.variableElement:
    case E.localVariableElement:
    case E.alias:
    case E.parameterElement:
      return CompletionItemKind.Variable;
    case E.memberVariableElement:
    case E.memberGetAccessorElement:
    case E.memberSetAccessorElement:
      return CompletionItemKind.Field;
    case E.functionElement:
    case E.localFunctionElement:
      return CompletionItemKind.Function;
    case E.memberFunctionElement:
    case E.constructSignatureElement:
    case E.callSignatureElement:
    case E.indexSignatureElement:
      return CompletionItemKind.Method;
    case E.enumElement:
      return CompletionItemKind.Enum;
    case E.enumMemberElement:
      return CompletionItemKind.EnumMember;
    case E.moduleElement:
    case E.externalModuleName:
      return CompletionItemKind.Module;
    case E.classElement:
    case E.typeElement:
      return CompletionItemKind.Class;
    case E.interfaceElement:
      return CompletionItemKind.Interface;
    case E.warning:
      return CompletionItemKind.Text;
    case E.scriptElement:
      return CompletionItemKind.File;
    case E.directory:
      return CompletionItemKind.Folder;
    case E.string:
      return CompletionItemKind.Constant;
    case E.constructorImplementationElement:
      return CompletionItemKind.Constructor;
    case E.typeParameterElement:
      return CompletionItemKind.TypeParameter;
    default:
      return CompletionItemKind.Property;
  }
}

export function toSymbolKind(kind: ts.ScriptElementKind): SymbolKind {
  switch (kind) {
    case E.moduleElement:
      return SymbolKind.Module;
    case E.classElement:
    case E.localClassElement:
      return SymbolKind.Class;
    case E.interfaceElement:
      return SymbolKind.Interface;
    case E.enumElement:
      return SymbolKind.Enum;
    case E.enumMemberElement:
      return SymbolKind.EnumMember;
    case E.memberVariableElement:
      return SymbolKind.Field;
    case E.memberGetAccessorElement:
    case E.memberSetAccessorElement:
      return SymbolKind.Property;
    case E.memberFunctionElement:
      return SymbolKind.Method;
    case E.constructorImplementationElement:
      return SymbolKind.Constructor;
    case E.functionElement:
    case E.localFunctionElement:
      return SymbolKind.Function;
    case E.constElement:
      return SymbolKind.Constant;
    case E.typeParameterElement:
      return SymbolKind.TypeParameter;
    case E.scriptElement:
      return SymbolKind.File;
    default:
      return SymbolKind.Variable;
  }
}

/** Renders JSDoc tags (`@param`, `@returns`, ...) as Markdown. */
function tagsToMarkdown(tags: readonly ts.JSDocTagInfo[] | undefined): string {
  if (!tags?.length) return '';
  return tags
    .map((tag) => {
      const text = ts.displayPartsToString(tag.text);
      if (tag.name === 'param' && tag.text?.length) {
        const [name, ...rest] = tag.text;
        const body = ts.displayPartsToString(rest).replace(/^\s*-?\s*/, '');
        return `*@param* \`${name?.text ?? ''}\`${body ? ` — ${body}` : ''}`;
      }
      if (tag.name === 'example') return `*@example*\n\`\`\`javascript\n${text}\n\`\`\``;
      return `*@${tag.name}*${text ? ` — ${text}` : ''}`;
    })
    .join('\n\n');
}

/** Builds the Markdown body (signature code block, docs, tags) used by hover and completion resolve. */
export function toMarkdown(
  signature: readonly ts.SymbolDisplayPart[] | undefined,
  documentation: readonly ts.SymbolDisplayPart[] | undefined,
  tags: readonly ts.JSDocTagInfo[] | undefined,
  includeSignature = true,
): string {
  const parts: string[] = [];
  const sig = ts.displayPartsToString(signature as ts.SymbolDisplayPart[] | undefined);
  if (includeSignature && sig) parts.push(`\`\`\`typescript\n${sig}\n\`\`\``);
  const doc = ts.displayPartsToString(documentation as ts.SymbolDisplayPart[] | undefined);
  if (doc) parts.push(doc);
  const tagText = tagsToMarkdown(tags);
  if (tagText) parts.push(tagText);
  return parts.join('\n\n---\n\n');
}
