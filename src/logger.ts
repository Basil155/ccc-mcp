import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SECRET_ENV_NAMES } from "./env.js";

/**
 * JSONL-лог вызовов.
 *
 * Важно: stdout занят MCP-протоколом, любая запись туда ломает транспорт.
 * Поэтому всё идёт в файл, а дублирование — строго в stderr.
 */

export type LogEvent =
  | "startup"
  | "start"
  | "finish"
  | "timeout"
  | "cancel"
  | "error"
  /** Явное одобрение плана — событие авторизации. */
  | "approve"
  /** Отказ в выполнении: нужен для аудита не меньше, чем сами запуски. */
  | "denied"
  /** Решение PreToolUse-хука по конкретной операции дочернего CLI. */
  | "hook"
  /** Решение оператора по запросу на разрешение — событие авторизации. */
  | "permission"
  /** Прямое чтение файла проекта — без запуска дочернего CLI. */
  | "file_read"
  /** Прямая запись в файл проекта — изменение вне протокола одобрения. */
  | "file_write"
  /** Прямой листинг дерева проекта — без запуска дочернего CLI. */
  | "file_list"
  /** Прямая git-операция — без запуска дочернего CLI и вне протокола одобрения. */
  | "git_op"
  /**
   * Сводка живого состояния идущей задачи — телеметрия, а не аудит.
   *
   * Счётчики и имена инструментов; текст модели и выжимки вызовов сюда не
   * попадают (см. progressLogFields). Пишется под флагом logProgress и не чаще
   * logProgressIntervalMs на задачу.
   */
  | "progress"
  /**
   * Разбор потока событий пошёл не так: непарсящаяся строка, строка сверх
   * предела или отсутствие итоговой строки result.
   *
   * Единственное окно в смену формата stream-json дочернего CLI: счётчики
   * bad_lines живут в отчёте одной задачи, а тут дрейф виден по всему логу.
   * Не чаще одной записи на класс сбоя на процесс — при полностью сломанном
   * формате плохих строк бывают сотни в секунду. Содержимое строки не пишется
   * никогда, только её длина.
   */
  | "stream_warn"
  /**
   * Вызов отбит проверкой inputSchema ещё до хендлера (SDK отвечает -32602).
   * Только имена ключей и типы значений, самих значений нет.
   */
  | "invalid_args";

export interface LogRecord {
  event: LogEvent;
  [key: string]: unknown;
}

/** Секреты, которые вырезаем из любой логируемой строки. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  // Bearer-токены и длинные base64-подобные строки после ключевых слов.
  /\b(bearer|token|api[_-]?key|secret|password)\b\s*[:=]\s*\S+/gi,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Для пар «имя: значение» сохраняем имя, прячем только значение.
      const sep = match.search(/[:=]/);
      return sep === -1 ? "«вырезано»" : `${match.slice(0, sep + 1)} «вырезано»`;
    });
  }
  // На случай, если значение секретной переменной попало в текст целиком.
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      out = out.split(value).join("«вырезано»");
    }
  }
  return out;
}

/** Рекурсивно чистит структуру перед записью. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "«слишком глубоко»";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  private ready = false;

  constructor(private readonly file: string) {}

  private ensureDir(): void {
    if (this.ready) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.ready = true;
    } catch (err) {
      this.ready = true; // не пытаемся снова на каждой записи
      this.stderr(`не удалось создать каталог для лога: ${String(err)}`);
    }
  }

  write(record: LogRecord): void {
    this.ensureDir();
    const line = {
      ts: new Date().toISOString(),
      ...(redact(record) as Record<string, unknown>),
    };
    try {
      appendFileSync(this.file, JSON.stringify(line) + "\n", "utf8");
    } catch (err) {
      // Отказ логирования не должен ронять сервер.
      this.stderr(`не удалось записать лог: ${String(err)}`);
    }
  }

  /** Диагностика для человека: только stderr, никогда stdout. */
  stderr(message: string): void {
    process.stderr.write(`[ccc-mcp] ${redactString(message)}\n`);
  }
}

/** Обрезает текст задачи до заданной длины для лога. */
export function preview(text: string, chars: number): string {
  if (chars <= 0) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : flat.slice(0, chars) + "…";
}
