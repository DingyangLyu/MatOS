import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { LOCALE_LABEL, LOCALES } from "../apps/web/src/i18n/types.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const localesDirectory = path.join(repoRoot, "apps/web/src/i18n/locales");
const i18nIndexPath = path.join(repoRoot, "apps/web/src/i18n/index.tsx");

type CheckResult = {
  name: string;
  errors: string[];
};

function repositoryPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function localeFileName(locale: string): string {
  return `${locale}.ts`;
}

function extractDictKeys(indexSource: string): string[] {
  const match = indexSource.match(
    /const (?:DICTS|DICT_LOADERS):[^\n]*=\s*{([\s\S]*?)\n};/,
  );
  if (!match?.[1]) return [];

  return Array.from(
    match[1].matchAll(/^\s*(?:["']([^"']+)["']|([A-Za-z][A-Za-z0-9-]*))\s*:/gm),
  )
    .map((entry) => entry[1] ?? entry[2])
    .filter((entry): entry is string => entry != null && entry.length > 0);
}

async function checkUiLocaleRegistration(): Promise<CheckResult> {
  const errors: string[] = [];
  const localeSet = new Set<string>(LOCALES);
  const localeFiles = (await readdir(localesDirectory)).filter((fileName) => fileName.endsWith(".ts")).sort();
  const localeFileSet = new Set(localeFiles);
  const dictKeys = extractDictKeys(await readFile(i18nIndexPath, "utf8"));
  const dictKeySet = new Set(dictKeys);

  for (const locale of LOCALES) {
    const fileName = localeFileName(locale);
    if (!localeFileSet.has(fileName)) {
      errors.push(`${locale} is listed in LOCALES but ${repositoryPath(path.join(localesDirectory, fileName))} is missing.`);
    }

    if (!(locale in LOCALE_LABEL)) {
      errors.push(`${locale} is listed in LOCALES but LOCALE_LABEL has no entry.`);
    }

    if (!dictKeySet.has(locale)) {
      errors.push(`${locale} is listed in LOCALES but the dictionary registry has no entry in ${repositoryPath(i18nIndexPath)}.`);
    }
  }

  for (const fileName of localeFiles) {
    const locale = fileName.replace(/\.ts$/, "");
    if (!localeSet.has(locale)) {
      errors.push(`${repositoryPath(path.join(localesDirectory, fileName))} exists but ${locale} is not listed in LOCALES.`);
    }
  }

  for (const dictKey of dictKeys) {
    if (!localeSet.has(dictKey)) {
      errors.push(`The dictionary registry contains ${dictKey}, but ${dictKey} is not listed in LOCALES.`);
    }
  }

  return { name: "UI locale registration", errors };
}

const checks = [checkUiLocaleRegistration];
const results: CheckResult[] = [];

for (const check of checks) {
  try {
    results.push(await check());
  } catch (error) {
    results.push({ name: check.name, errors: [`Unexpected check failure: ${String(error)}`] });
  }
}

const failures = results.flatMap((result) => result.errors.map((error) => ({ check: result.name, error })));

if (failures.length > 0) {
  console.error("i18n P0 check failed:");
  for (const failure of failures) {
    console.error(`- [${failure.check}] ${failure.error}`);
  }
  process.exitCode = 1;
} else {
  console.log("i18n P0 check passed: locale registration is consistent.");
}
