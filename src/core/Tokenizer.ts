const tokenPattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export const tokenize = (value: string): string[] =>
  value.normalize("NFC").toLowerCase().match(tokenPattern) ?? [];

export const normalizePhrase = (value: string): string =>
  tokenize(value).join(" ");

export const codeUnitCompare = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
