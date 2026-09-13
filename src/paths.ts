import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class ProjectDirError extends Error {}

export class ProjectFileError extends Error {}

const isWindows = process.platform === "win32";

/**
 * Проверяет, что `dir` лежит внутри `root` (или совпадает с ним).
 *
 * Через path.relative, а не startsWith: префиксное сравнение пропустило бы
 * `D:\Projects-other` как «вложенный» в `D:\Projects`.
 */
function isInside(root: string, dir: string): boolean {
  const a = isWindows ? root.toLowerCase() : root;
  const b = isWindows ? dir.toLowerCase() : dir;
  if (a === b) return true;

  const rel = relative(a, b);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Валидирует project_dir против белого списка и возвращает канонический путь.
 *
 * Порядок важен: сначала realpath (снимает симлинки, junction'ы и нормализует
 * регистр на Windows), и только потом проверка вхождения — иначе симлинк из
 * разрешённого каталога наружу обошёл бы белый список.
 */
export function validateProjectDir(
  projectDir: string,
  allowedRoots: readonly string[],
): string {
  const input = projectDir?.trim();
  if (!input) {
    throw new ProjectDirError("project_dir не задан");
  }
  if (!isAbsolute(input)) {
    throw new ProjectDirError(
      `project_dir должен быть абсолютным путём, получено: ${input}`,
    );
  }

  let real: string;
  try {
    real = realpathSync.native(input);
  } catch {
    throw new ProjectDirError(`project_dir не существует или недоступен: ${input}`);
  }

  try {
    if (!statSync(real).isDirectory()) {
      throw new ProjectDirError(`project_dir не является каталогом: ${input}`);
    }
  } catch (err) {
    if (err instanceof ProjectDirError) throw err;
    throw new ProjectDirError(`не удалось проверить project_dir: ${input}`);
  }

  for (const root of allowedRoots) {
    if (isInside(root, real)) return real;
  }

  throw new ProjectDirError(
    `project_dir вне белого списка: ${real}\n` +
      `Разрешённые корни: ${allowedRoots.join(", ")}\n` +
      `Добавьте нужный путь в allowedRoots конфига, если это ожидаемо.`,
  );
}

/** Путь к файлу проекта, уже проверенный на вхождение в project_dir. */
export interface ResolvedProjectFile {
  /** Канонический project_dir (уже проверенный по allowedRoots). */
  root: string;
  /** Абсолютный путь к файлу внутри root. */
  absolute: string;
  /** Путь относительно root, через '/', — для ответа и лога. */
  relative: string;
  /** Существует ли файл на момент проверки. */
  exists: boolean;
}

/** То же для листинга, где цель законно может оказаться каталогом. */
export interface ResolvedProjectEntry extends ResolvedProjectFile {
  /** Каталог ли цель. Для несуществующего пути всегда false. */
  isDir: boolean;
}

/**
 * Ближайший существующий предок пути.
 *
 * Нужен для ещё не созданного файла: realpath на несуществующем пути падает,
 * а снять симлинки с его каталога-предка всё равно необходимо.
 */
function nearestExisting(target: string): string {
  let current = target;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      // Дошли до корня ФС: дальше подниматься некуда.
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Общая часть резолва: границы уже проверены, тип цели — ещё нет. */
interface InsideTarget {
  root: string;
  /** Канонический путь: realpath для существующей цели, лексический для будущей. */
  canonical: string;
  /** realpath существующей цели — по нему безопасно делать statSync. */
  real: string;
  exists: boolean;
  /** Нормализованный вход — для текстов ошибок. */
  input: string;
}

/**
 * Резолвит path относительно project_dir и проверяет, что результат остался внутри.
 *
 * Двухступенчатая защита: сначала лексическая (resolve + isInside ловит `../` и
 * `a/../../b`), затем физическая (realpath ловит симлинк из разрешённого
 * каталога наружу). Одной лексической недостаточно ровно по той же причине,
 * что описана у validateProjectDir.
 *
 * Абсолютный path отвергается всегда, даже если указывает внутрь: интерфейс
 * инструмента принимает только пути относительно project_dir.
 *
 * Проверки типа цели здесь нет намеренно: она разная у чтения/записи одного
 * файла и у листинга, которому каталог как раз нужен. Сама же граница
 * project_dir — единственная защита файловых инструментов, и дублировать её
 * копипастой в двух функциях нельзя.
 */
function resolveInside(
  projectDir: string,
  relPath: string,
  allowedRoots: readonly string[],
): InsideTarget {
  const root = validateProjectDir(projectDir, allowedRoots);

  const input = relPath?.trim();
  if (!input) {
    throw new ProjectFileError("path не задан");
  }
  if (input.includes("\0")) {
    throw new ProjectFileError("path содержит недопустимый символ");
  }
  if (isAbsolute(input)) {
    throw new ProjectFileError(
      `path должен быть относительным путём внутри project_dir, получено: ${input}`,
    );
  }

  const absolute = resolve(root, input);
  if (!isInside(root, absolute)) {
    throw new ProjectFileError(`path выходит за пределы project_dir: ${input}`);
  }

  // lstat, а не existsSync: битая симлинка «не существует» для existsSync, но
  // запись через неё ушла бы по адресу ссылки — такой путь нужно отклонить.
  let exists: boolean;
  try {
    lstatSync(absolute);
    exists = true;
  } catch {
    exists = false;
  }

  const probe = exists ? absolute : nearestExisting(dirname(absolute));
  let real: string;
  try {
    real = realpathSync.native(probe);
  } catch {
    // Сюда попадает и битая симлинка: fail-closed, доступ не даём.
    throw new ProjectFileError(`не удалось проверить path: ${input}`);
  }
  if (!isInside(root, real)) {
    throw new ProjectFileError(
      `path ведёт за пределы project_dir через символическую ссылку: ${input}`,
    );
  }

  // Для существующей цели канонизируем путь (симлинк внутри проекта ведёт
  // к настоящему файлу — писать и логировать надо именно его).
  return { root, canonical: exists ? real : absolute, real, exists, input };
}

function toResolved(target: InsideTarget): ResolvedProjectFile {
  return {
    root: target.root,
    absolute: target.canonical,
    relative: relative(target.root, target.canonical).split(sep).join("/"),
    exists: target.exists,
  };
}

/** statSync существующей цели с единым текстом отказа. */
function statTarget(target: InsideTarget): Stats {
  try {
    return statSync(target.real);
  } catch {
    throw new ProjectFileError(`не удалось проверить path: ${target.input}`);
  }
}

/**
 * Резолвит path под чтение/запись одного файла: каталог и всё прочее отвергаются.
 *
 * Несуществующий path — не ошибка: write_project_file по нему создаёт файл.
 */
export function resolveProjectFile(
  projectDir: string,
  relPath: string,
  allowedRoots: readonly string[],
): ResolvedProjectFile {
  const target = resolveInside(projectDir, relPath, allowedRoots);

  if (target.exists && !statTarget(target).isFile()) {
    throw new ProjectFileError(`path не является обычным файлом: ${target.input}`);
  }

  return toResolved(target);
}

/**
 * То же, но каталог — легальная цель. Нужен листингу: он и файл покажет, и
 * поддерево обойдёт, а вот сокет или устройство ему так же бесполезны.
 */
export function resolveProjectEntry(
  projectDir: string,
  relPath: string,
  allowedRoots: readonly string[],
): ResolvedProjectEntry {
  const target = resolveInside(projectDir, relPath, allowedRoots);

  let isDir = false;
  if (target.exists) {
    const st = statTarget(target);
    isDir = st.isDirectory();
    if (!isDir && !st.isFile()) {
      throw new ProjectFileError(`path не является файлом или каталогом: ${target.input}`);
    }
  }

  return { ...toResolved(target), isDir };
}
