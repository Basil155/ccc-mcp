/**
 * Разбиение потока NDJSON на отдельные события.
 *
 * Модуль намеренно ничего не знает про остальной проект: на входе строки,
 * на выходе колбэки. Это позволяет гонять его в офлайн-тестах на фикстурах
 * и не тащить в тесты ни конфиг, ни логгер, ни дочерний процесс.
 *
 * Почему не node:readline: он всё равно буферизует строку целиком, то есть
 * не решает проблему 700-КБ строки от tool_result, а прячет её. Свой сплиттер
 * умеет выбросить переполнение, вообще не парся его, и не добавляет второй
 * жизненный цикл ('close' интерфейса), который пришлось бы упорядочивать с
 * 'close' дочернего процесса.
 */

export interface StreamEvent {
  /** Разобранный объект строки. */
  data: Record<string, unknown>;
  /** data.type, если это строка; иначе "". */
  type: string;
  /** Длина исходной строки в символах (без завершающего перевода строки). */
  chars: number;
}

export type BadLineReason = "unparseable" | "too_long";

/**
 * Предел на одну строку NDJSON.
 *
 * Строка сверх предела выбрасывается целиком, а не обрезается: обрезанный JSON
 * всё равно не парсится, поэтому тратить на него память и время нет смысла.
 * Меньше сделать нельзя: порядок ключей в строке result не фиксирован, её не
 * опознать по префиксу, значит предел обязан быть заведомо больше любого
 * мыслимого result.
 */
export const MAX_EVENT_LINE_CHARS = 2_000_000;

/** Хвост stdout, который сохраняем для диагностики parse_error. */
export const MAX_STDOUT_TAIL = 8192;

/** Хвост stderr. Сегодня он копится без ограничений. */
export const MAX_STDERR_TAIL = 8192;

export interface NdjsonSplitterOptions {
  /** По умолчанию MAX_EVENT_LINE_CHARS. */
  maxLineChars?: number;
  onEvent: (ev: StreamEvent) => void;
  onBadLine: (chars: number, reason: BadLineReason) => void;
}

export class NdjsonSplitter {
  private readonly maxLineChars: number;
  private readonly onEvent: (ev: StreamEvent) => void;
  private readonly onBadLine: (chars: number, reason: BadLineReason) => void;

  /** Хвост последнего чанка: всё после последнего перевода строки. */
  private buffer = "";
  /**
   * Режим сброса: текущая строка уже превысила предел, её содержимое не
   * хранится — считаем только длину до ближайшего перевода строки.
   */
  private dropping = false;
  private droppedChars = 0;

  constructor(opts: NdjsonSplitterOptions) {
    this.maxLineChars = opts.maxLineChars ?? MAX_EVENT_LINE_CHARS;
    this.onEvent = opts.onEvent;
    this.onBadLine = opts.onBadLine;
  }

  /**
   * Принимает очередной кусок потока произвольного размера.
   *
   * Единственное состояние между вызовами — хвост строки, поэтому результат
   * не зависит от того, как поток нарезан на чанки: посимвольная подача даёт
   * ту же последовательность событий, что и подача файла целиком.
   */
  push(chunk: string): void {
    if (chunk === "") return;

    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl === -1) break;
      this.append(chunk.slice(start, nl));
      this.endLine();
      start = nl + 1;
    }
    // Остаток без перевода строки ждёт следующего чанка или flush().
    this.append(chunk.slice(start));
  }

  /**
   * Отдаёт последнюю строку, пришедшую без завершающего перевода строки.
   *
   * Идемпотентен: вызывается и на 'end' потока, и защитно при завершении
   * процесса, а эти два события не упорядочены между собой.
   */
  flush(): void {
    if (this.buffer === "" && !this.dropping) return;
    this.endLine();
  }

  /** Копит хвост текущей строки, следя за пределом длины. */
  private append(part: string): void {
    if (part === "") return;
    if (this.dropping) {
      this.droppedChars += part.length;
      return;
    }
    if (this.buffer.length + part.length > this.maxLineChars) {
      // Переходим в режим сброса: содержимое больше не нужно, нужна длина.
      this.dropping = true;
      this.droppedChars = this.buffer.length + part.length;
      this.buffer = "";
      return;
    }
    this.buffer += part;
  }

  /** Завершает текущую строку: разбирает её либо сообщает о плохой. */
  private endLine(): void {
    if (this.dropping) {
      const chars = this.droppedChars;
      this.dropping = false;
      this.droppedChars = 0;
      this.onBadLine(chars, "too_long");
      return;
    }

    const line = this.buffer;
    this.buffer = "";
    if (line === "") return;

    // CRLF в потоке не наблюдался, но отбросить лишний \r дешевле, чем
    // объяснять потом, почему JSON.parse падает на невидимом символе.
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text === "") return;

    // Пустые строки игнорируем молча: они не признак поломки формата и в
    // счётчик плохих строк идти не должны.
    const chars = line.length;

    // Непарсящийся шум (например, диагностика CLI вида [claude-code:…])
    // не должен стоить ни одного JSON.parse.
    if (text.charCodeAt(0) !== 123 /* { */) {
      this.onBadLine(chars, "unparseable");
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.onBadLine(chars, "unparseable");
      return;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      this.onBadLine(chars, "unparseable");
      return;
    }

    const record = data as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    this.onEvent({ data: record, type, chars });
  }
}
