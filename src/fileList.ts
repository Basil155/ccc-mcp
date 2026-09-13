import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Dirent, Stats } from "node:fs";

import { FileOpError } from "./fileOps.js";
import { resolveProjectEntry } from "./paths.js";

/**
 * Листинг дерева проекта — без запуска дочернего Claude Code.
 *
 * Отдельный модуль, а не продолжение fileOps.ts: обход дерева и матчер
 * .gitignore — самостоятельная задача, у которой с чтением и записью одного
 * файла нет ни строчки общего кода. Класс ошибки при этом общий: снаружи
 * «файл слишком большой» и «путь не найден» — один и тот же операционный отказ.
 *
 * Асинхронность по тому же правилу, что в fileOps.ts: обход может задеть тысячи
 * записей, и блокировать event loop, пока другие задачи стримят stdout, нельзя.
 */

/**
 * Всегда игнорируется, даже при use_default_ignores: false.
 *
 * Внутри .git тысячи служебных объектов и ни одного файла, предназначенного
 * для чтения или записи этими инструментами; без исключения бюджет записей
 * выгорал бы на первом же каталоге. Единственное жёсткое исключение.
 */
const HARD_IGNORES: readonly string[] = [".git"];

/**
 * Дефолтный игнор-лист: генерируемое и вендоренное, чего в листинге проекта
 * не ждут. Отключается параметром use_default_ignores.
 *
 * .idea включён (десятки файлов машинного состояния IDE), а .vscode — нет:
 * он маленький, часто лежит в репозитории, и settings.json/launch.json — как
 * раз тот конфиг, который агента и просят показать.
 */
export const DEFAULT_IGNORES: readonly string[] = [
  "node_modules",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".idea",
  ".DS_Store",
];

export interface ListEntry {
  /** Путь относительно project_dir, всегда через '/'. */
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Байты. Для каталогов и симлинок — 0. */
  size: number;
  /** ISO-время последнего изменения самой записи. */
  mtime: string;
}

export interface ListRequest {
  projectDir: string;
  /** Относительный путь; "." — корень проекта. */
  path: string;
  allowedRoots: readonly string[];
  recursive: boolean;
  /** Подстрока в имени файла, регистр не важен. */
  nameContains: string | null;
  /** Расширения без точки и в нижнем регистре; пустой список = фильтра нет. */
  extensions: string[] | null;
  /** Пользовательские паттерны игнора поверх остальных источников. */
  ignore: readonly string[];
  useDefaultIgnores: boolean;
  useGitignore: boolean;
  /** Предел числа записей в ответе. */
  limit: number;
  /** Предел числа просмотренных записей — защита от обхода без выдачи. */
  scanLimit: number;
}

export interface ListResult {
  root: string;
  /** Нормализованный запрошенный путь: "." для корня. */
  relativePath: string;
  entries: ListEntry[];
  fileCount: number;
  dirCount: number;
  truncated: boolean;
  truncatedReason: "limit" | "scanned" | null;
  /** Сколько записей каталогов просмотрено при обходе. */
  scanned: number;
  /** Сколько пропущено из-за ошибки доступа или гонки удаления. */
  unreadable: number;
  gitignoreFound: boolean;
  /** Сколько строк-отрицаний из .gitignore пришлось пропустить. */
  gitignoreNegationsIgnored: number;
  /** Был ли задан фильтр — тогда каталоги в выдачу не попадают. */
  filtered: boolean;
}

/** Скомпилированное правило игнора. */
interface IgnoreRule {
  re: RegExp;
  /** Правило с завершающим '/' — применимо только к каталогам. */
  dirOnly: boolean;
}

/**
 * Экранирует один символ, если он значим для RegExp.
 *
 * Классы символов вида [a-z] сознательно не поддерживаются: '[' попадает сюда
 * и матчится буквально.
 */
function escapeChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Один сегмент пути: '*' и '?' не пересекают разделитель. */
function segmentSource(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeChar(ch);
  }
  return out;
}

/** Тело паттерна в исходник RegExp. '**' как целый сегмент пересекает '/'. */
function patternSource(pattern: string): string {
  const parts = pattern.split("/");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    if (part === "**") {
      // Завершающий '**' — «всё, что ниже»; в середине — «ноль или больше сегментов».
      out += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    out += segmentSource(part);
    if (!last) out += "/";
  }
  return out;
}

/** null — строку нужно пропустить (комментарий, пустая, отрицание). */
function compileRule(raw: string): IgnoreRule | null {
  if (raw.startsWith("#")) return null;

  // Хвостовые пробелы в git значимы только экранированными — упрощаем.
  let pattern = raw.replace(/\s+$/, "");
  if (pattern === "") return null;
  if (pattern.startsWith("!")) return null;

  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes("/")) {
    // '/' внутри паттерна якорит его к корню проекта — как в git.
    anchored = true;
  }
  if (pattern === "") return null;

  const body = patternSource(pattern);
  // Правило матчится ровно на саму запись, без хвоста «и всё, что внутри»:
  // исключённый каталог обход и так обрезает, до его детей дело не доходит.
  // А вот при path прямо внутрь такого каталога дети обязаны показаться —
  // явно запрошенный путь под игнор не подпадает, и хвост это ломал бы.
  const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  return { re: new RegExp(source), dirOnly };
}

/**
 * Компилирует набор паттернов, считая пропущенные отрицания.
 *
 * Отрицания (!foo) не поддерживаются намеренно: корректная реализация требует
 * правила «выигрывает последнее совпадение» плюс «нельзя вернуть файл, если
 * исключён его родительский каталог». Полуправильная версия молча показала бы
 * или спрятала не те файлы. Пропуск сдвигает результат в сторону «файл остался
 * скрытым», поэтому счётчик уходит в ответ, а подсказка предлагает
 * use_gitignore: false.
 */
function compileRules(patterns: readonly string[]): {
  rules: IgnoreRule[];
  negations: number;
} {
  const rules: IgnoreRule[] = [];
  let negations = 0;
  for (const raw of patterns) {
    if (raw.replace(/\s+$/, "").startsWith("!")) negations++;
    const rule = compileRule(raw);
    if (rule !== null) rules.push(rule);
  }
  return { rules, negations };
}

function isIgnored(rules: readonly IgnoreRule[], relPath: string, isDir: boolean): boolean {
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(relPath)) return true;
  }
  return false;
}

/**
 * Читает .gitignore из корня проекта. null — файла нет либо он нечитаем.
 *
 * Только <project_dir>/.gitignore: вверх по дереву не поднимаемся и вложенные
 * .gitignore не читаем. Подъём вверх сделал бы результат зависящим от
 * каталогов вне белого списка, а project_dir и так корень проекта.
 */
async function readGitignore(root: string): Promise<string[] | null> {
  try {
    return (await readFile(join(root, ".gitignore"), "utf8")).split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Расширения к единому виду: без точки, в нижнем регистре. */
export function normalizeExtensions(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const ext = raw.trim().replace(/^\.+/, "").toLowerCase();
    if (ext !== "" && !out.includes(ext)) out.push(ext);
  }
  return out;
}

function toEntry(path: string, st: Stats, isDir: boolean, isSymlink: boolean): ListEntry {
  return {
    path,
    isDir,
    isSymlink,
    // Размер осмыслен только у обычного файла. У каталога он ничего не значит
    // (рекурсивную сумму по детям считать дорого и незачем), а у симлинки
    // lstat отдал бы длину строки-цели — это только сбивает с толку.
    size: isDir || isSymlink ? 0 : st.size,
    mtime: st.mtime.toISOString(),
  };
}

export async function listProjectFiles(req: ListRequest): Promise<ListResult> {
  const target = resolveProjectEntry(req.projectDir, req.path, req.allowedRoots);
  const shown = target.relative === "" ? "." : target.relative;

  if (!target.exists) {
    throw new FileOpError(
      `путь не найден: ${shown} (project_dir: ${target.root}). ` +
        `path считается от project_dir, а не от текущего каталога. Пустой список означал бы ` +
        `другое: каталог есть, но всё в нём отфильтровано.`,
    );
  }

  const nameContains = req.nameContains !== null ? req.nameContains.toLowerCase() : null;
  const extensions = req.extensions !== null && req.extensions.length > 0 ? req.extensions : null;
  const filtered = nameContains !== null || extensions !== null;

  const matchesFilter = (name: string): boolean => {
    if (nameContains !== null && !name.toLowerCase().includes(nameContains)) return false;
    if (extensions !== null) {
      const ext = extname(name).slice(1).toLowerCase();
      if (ext === "" || !extensions.includes(ext)) return false;
    }
    return true;
  };

  const entries: ListEntry[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let scanned = 0;
  let unreadable = 0;
  // В объекте, а не отдельным let: причину выставляют вложенные функции, и так
  // её тип не сужается до null по начальному значению.
  const stop: { reason: "limit" | "scanned" | null } = { reason: null };

  // Цель — файл: отдаём одну запись. Это дешёвый способ узнать размер и mtime,
  // не читая содержимое, и отказывать тут не за что.
  if (!target.isDir) {
    let st: Stats;
    try {
      st = await lstat(target.absolute);
    } catch (err) {
      throw new FileOpError(`не удалось прочитать ${shown}: ${String(err)}`);
    }
    // absolute уже канонизирован резолвером, симлинки на этом пути сняты.
    if (matchesFilter(target.relative.split("/").pop() ?? target.relative)) {
      entries.push(toEntry(target.relative, st, false, false));
      fileCount++;
    }
    return {
      root: target.root,
      relativePath: shown,
      entries,
      fileCount,
      dirCount,
      truncated: false,
      truncatedReason: null,
      scanned: 1,
      unreadable: 0,
      gitignoreFound: false,
      gitignoreNegationsIgnored: 0,
      filtered,
    };
  }

  // Правила игнора собираются один раз на весь обход.
  // К самому запрошенному path они не применяются: если пользователь показал
  // пальцем на dist/, он хочет увидеть именно dist/.
  const patterns: string[] = [...HARD_IGNORES];
  if (req.useDefaultIgnores) patterns.push(...DEFAULT_IGNORES);

  let gitignoreFound = false;
  let gitignoreNegationsIgnored = 0;
  if (req.useGitignore) {
    const lines = await readGitignore(target.root);
    if (lines !== null) {
      gitignoreFound = true;
      const compiled = compileRules(lines);
      gitignoreNegationsIgnored = compiled.negations;
      patterns.push(...lines);
    }
  }
  patterns.push(...req.ignore);

  const { rules } = compileRules(patterns);

  /** Кладёт запись, соблюдая лимит. false — лимит исчерпан, обход пора кончать. */
  const push = (entry: ListEntry): boolean => {
    if (entries.length >= req.limit) {
      stop.reason = "limit";
      return false;
    }
    entries.push(entry);
    if (entry.isDir) dirCount++;
    else fileCount++;
    return true;
  };

  /**
   * Обход в прямом порядке (pre-order): запись каталога выдаётся до спуска в
   * него, дети отсортированы по имени. Итог читается как дерево, а усечение по
   * лимиту отрезает предсказуемый «хвост алфавита».
   */
  const walk = async (abs: string, rel: string): Promise<void> => {
    if (stop.reason !== null) return;

    let dirents: Dirent[];
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      // EACCES или каталог исчез по дороге — пропускаем поддерево, но листинг
      // целиком из-за этого не роняем.
      unreadable++;
      return;
    }

    // Сравнение код-юнитов, а не localeCompare: тот зависит от версии ICU,
    // а порядок ответа обязан быть одинаковым везде.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // lstat батчем по каталогу: последовательные await на тысяче записей стоят
    // тысячи проходов по циклу микротасок, а порядок Promise.all сохраняет.
    const stats = await Promise.all(
      dirents.map((d) => lstat(join(abs, d.name)).catch(() => null)),
    );

    for (let i = 0; i < dirents.length; i++) {
      if (stop.reason !== null) return;

      scanned++;
      if (scanned > req.scanLimit) {
        stop.reason = "scanned";
        return;
      }

      const dirent = dirents[i]!;
      const st = stats[i];
      if (st === null || st === undefined) {
        unreadable++;
        continue;
      }

      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const isSymlink = st.isSymbolicLink();
      const isDir = !isSymlink && st.isDirectory();

      // Сокеты, fifo и устройства пропускаем: контракт тула — то, что можно
      // передать в read/write_project_file, плюс каталоги.
      if (!isSymlink && !isDir && !st.isFile()) continue;

      if (isIgnored(rules, childRel, isDir)) continue;

      if (isDir) {
        // При заданном фильтре каталоги в выдачу не попадают — при поиске это
        // структурный шум. Но обход они всё равно не сужают: спускаться надо,
        // иначе ничего бы не находилось.
        if (!filtered && !push(toEntry(childRel, st, true, false))) return;
        if (req.recursive) await walk(join(abs, dirent.name), childRel);
        continue;
      }

      // Симлинку показываем записью, но внутрь не заходим никогда. Это разом
      // и защита от петель (в петлю просто некуда войти), и защита границы
      // project_dir: ссылка наружу не превращает листинг в способ её обойти.
      if (matchesFilter(dirent.name) && !push(toEntry(childRel, st, false, isSymlink))) return;
    }
  };

  await walk(target.absolute, target.relative);

  return {
    root: target.root,
    relativePath: shown,
    entries,
    fileCount,
    dirCount,
    truncated: stop.reason !== null,
    truncatedReason: stop.reason,
    scanned,
    unreadable,
    gitignoreFound,
    gitignoreNegationsIgnored,
    filtered,
  };
}
