import { createHash } from "node:crypto";
import { existsSync, statSync, type Stats } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";

import { resolveProjectFile, type ResolvedProjectFile } from "./paths.js";

/**
 * Прямые файловые операции над проектом — без запуска дочернего Claude Code.
 *
 * Тела файлов читаются и пишутся через fs/promises, хотя остальной проект
 * синхронный: сервер однопоточный и параллельно может стримить stdout
 * работающих задач, блокировать event loop на полмегабайта незачем. Дешёвые
 * метаданные (statSync, existsSync) остаются синхронными, как в paths.ts.
 */

/** Операционный отказ: не найден, слишком большой, бинарный, ошибка ФС. */
export class FileOpError extends Error {}

/** Сколько первых байт нюхаем, решая «текст или бинарь». */
const SNIFF_BYTES = 8192;

/** Предел размера прежнего содержимого, которое возвращается в ответе записи. */
export const PREVIOUS_CONTENT_LIMIT = 64 * 1024;

export type Eol = "lf" | "crlf" | "mixed" | "none";

export interface ReadFileResult {
  root: string;
  relativePath: string;
  content: string;
  bytes: number;
  /** ISO-время последнего изменения. */
  mtime: string;
  sha256: string;
  encoding: "utf-8";
  hasBom: boolean;
  eol: Eol;
  lines: number;
}

/** Прежнее состояние перезаписанного файла — чтобы показать пользователю разницу. */
export interface PreviousFile {
  bytes: number;
  /** null, если прежний файл было нельзя прочитать целиком. */
  sha256: string | null;
  mtime: string;
  lines: number | null;
  /** Прежнее содержимое, если его безопасно вернуть; иначе null + omittedReason. */
  content: string | null;
  omittedReason: string | null;
}

export interface WriteFileOutcome {
  root: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  existed: boolean;
  /** Новое содержимое побайтово совпало с прежним — правка ничего не изменила. */
  unchanged: boolean;
  /** Относительные пути каталогов, созданных этой записью. */
  createdDirs: string[];
  previous: PreviousFile | null;
  mtime: string;
}

export interface ReadRequest {
  projectDir: string;
  path: string;
  allowedRoots: readonly string[];
  maxBytes: number;
}

export interface WriteRequest extends ReadRequest {
  content: string;
  includePrevious: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT"
  );
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Похоже ли содержимое на бинарное. Возвращает причину или null для текста.
 *
 * Смотрим содержимое, а не расширение: расширение врёт в обе стороны — бывает
 * и мусор в .md, и текст без расширения (Dockerfile, .gitignore), а список
 * расширений пришлось бы вечно пополнять.
 *
 * Нулевой байт — классическая эвристика git/grep. Доля прочих управляющих
 * байт добавлена ради UTF-16 и подобного: там NUL есть не всегда, а читать
 * такое как UTF-8 всё равно бессмысленно.
 */
function looksBinary(buf: Buffer): string | null {
  const limit = Math.min(buf.length, SNIFF_BYTES);
  if (limit === 0) return null;

  let control = 0;
  for (let i = 0; i < limit; i++) {
    const byte = buf[i]!;
    if (byte === 0) return "нулевой байт в начале файла";
    // \t (0x09), \n (0x0a), \v (0x0b), \f (0x0c), \r (0x0d) — легальны в тексте.
    if (byte <= 0x08 || (byte >= 0x0e && byte <= 0x1f)) control++;
  }

  const share = control / limit;
  if (share > 0.1) {
    return `${Math.round(share * 100)}% управляющих байт в начале файла`;
  }
  return null;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split("\n").length;
  // Финальный перевод строки не открывает новую строку.
  return text.endsWith("\n") ? parts - 1 : parts;
}

function detectEol(text: string): Eol {
  const total = (text.match(/\n/g) ?? []).length;
  if (total === 0) return "none";
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "lf";
  if (crlf === total) return "crlf";
  return "mixed";
}

/** `clause` — согласованное начало фразы, вида «файл x.md слишком большой». */
function tooBig(clause: string, size: number, maxBytes: number): FileOpError {
  return new FileOpError(
    `${clause}: ${size} байт при лимите ${maxBytes} (maxFileBytes). ` +
      `Этот инструмент работает с текстовыми файлами только целиком — ` +
      `для больших файлов используйте plan_task/execute_task.`,
  );
}

function statFile(absolute: string, relativePath: string): Stats {
  try {
    return statSync(absolute);
  } catch (err) {
    if (isEnoent(err)) throw new FileOpError(`файл не найден: ${relativePath}`);
    throw new FileOpError(`не удалось прочитать файл ${relativePath}: ${errText(err)}`);
  }
}

async function readBuffer(absolute: string, relativePath: string): Promise<Buffer> {
  try {
    return await readFile(absolute);
  } catch (err) {
    if (isEnoent(err)) throw new FileOpError(`файл не найден: ${relativePath}`);
    throw new FileOpError(`не удалось прочитать файл ${relativePath}: ${errText(err)}`);
  }
}

/**
 * Создаёт недостающие каталоги и возвращает список созданных.
 *
 * Отсутствующие каталоги собираем ДО mkdir: после него отличить новые от уже
 * бывших нельзя, а в отчёте это нужно — опечатка в path иначе молча заводит
 * мусорное дерево.
 */
async function ensureDirs(target: ResolvedProjectFile): Promise<string[]> {
  const dir = dirname(target.absolute);
  if (existsSync(dir)) return [];

  const missing: string[] = [];
  let current = dir;
  while (current !== target.root && !existsSync(current)) {
    missing.push(relative(target.root, current).split(sep).join("/"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new FileOpError(
      `не удалось создать каталог для ${target.relative}: ${errText(err)}`,
    );
  }
  return missing.reverse();
}

function rejectBinary(buf: Buffer, relativePath: string): void {
  const reason = looksBinary(buf);
  if (reason !== null) {
    throw new FileOpError(
      `похоже на бинарный файл (${reason}): ${relativePath}. ` +
        `Этот инструмент работает только с текстом.`,
    );
  }
}

export async function readProjectFile(req: ReadRequest): Promise<ReadFileResult> {
  const target = resolveProjectFile(req.projectDir, req.path, req.allowedRoots);
  if (!target.exists) {
    throw new FileOpError(
      `файл не найден: ${target.relative} (project_dir: ${target.root}). ` +
        `Пустой файл читается штатно — это именно отсутствие файла.`,
    );
  }

  // Размер проверяем по stat, до чтения: частичное чтение не предусмотрено,
  // а грузить в память гигабайт ради отказа тем более не нужно.
  const st = statFile(target.absolute, target.relative);
  if (st.size > req.maxBytes) {
    throw tooBig(`файл ${target.relative} слишком большой`, st.size, req.maxBytes);
  }

  const buf = await readBuffer(target.absolute, target.relative);
  rejectBinary(buf, target.relative);

  const text = buf.toString("utf8");
  return {
    root: target.root,
    relativePath: target.relative,
    content: text,
    bytes: buf.byteLength,
    mtime: st.mtime.toISOString(),
    sha256: sha256(buf),
    encoding: "utf-8",
    // BOM передаём как есть: не срезаем и не добавляем, иначе обратная запись
    // молча изменила бы файл.
    hasBom: text.startsWith("﻿"),
    eol: detectEol(text),
    lines: countLines(text),
  };
}

function buildPrevious(
  st: Stats,
  buf: Buffer | null,
  includePrevious: boolean,
): PreviousFile {
  let content: string | null = null;
  let omittedReason: string | null = null;

  if (!includePrevious) {
    omittedReason = "возврат прежнего содержимого отключён параметром include_previous";
  } else if (buf === null) {
    omittedReason = `прежний файл слишком большой для возврата: ${st.size} байт`;
  } else if (buf.byteLength > PREVIOUS_CONTENT_LIMIT) {
    omittedReason =
      `прежний файл слишком большой для возврата: ${buf.byteLength} байт ` +
      `при пределе ${PREVIOUS_CONTENT_LIMIT}`;
  } else {
    const binary = looksBinary(buf);
    if (binary !== null) omittedReason = `прежний файл бинарный (${binary})`;
    else content = buf.toString("utf8");
  }

  return {
    bytes: st.size,
    sha256: buf !== null ? sha256(buf) : null,
    mtime: st.mtime.toISOString(),
    lines: content !== null ? countLines(content) : null,
    content,
    omittedReason,
  };
}

export async function writeProjectFile(req: WriteRequest): Promise<WriteFileOutcome> {
  const target = resolveProjectFile(req.projectDir, req.path, req.allowedRoots);

  const next = Buffer.from(req.content, "utf8");
  // Проверка до открытия файла: иначе на диске остался бы обрезанный файл.
  if (next.byteLength > req.maxBytes) {
    throw tooBig("содержимое слишком большое", next.byteLength, req.maxBytes);
  }

  // Прежнее состояние читаем до записи — после неё оно уже недоступно.
  // Читаем независимо от include_previous: sha256 прежнего файла нужен логу
  // для аудита, а сравнение буферов — для unchanged.
  let previous: PreviousFile | null = null;
  let previousBuf: Buffer | null = null;
  if (target.exists) {
    const st = statFile(target.absolute, target.relative);
    if (st.size <= req.maxBytes) {
      previousBuf = await readBuffer(target.absolute, target.relative);
    }
    previous = buildPrevious(st, previousBuf, req.includePrevious);
  }

  const createdDirs = await ensureDirs(target);

  // Пишем ровно то, что пришло: без нормализации переводов строк, без BOM и
  // без дописывания финального \n. Тул перезаписывает файл целиком и не должен
  // «улучшать» содержимое втихую.
  try {
    await writeFile(target.absolute, next);
  } catch (err) {
    throw new FileOpError(`не удалось записать файл ${target.relative}: ${errText(err)}`);
  }

  const after = statFile(target.absolute, target.relative);
  return {
    root: target.root,
    relativePath: target.relative,
    bytes: next.byteLength,
    sha256: sha256(next),
    existed: target.exists,
    unchanged: previousBuf !== null && previousBuf.equals(next),
    createdDirs,
    previous,
    mtime: after.mtime.toISOString(),
  };
}
