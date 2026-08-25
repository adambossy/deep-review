import type {
  DeclRef,
  DefinitionLocation,
  FunctionRelations,
  LanguageBackend,
} from "./backend.js";
import {
  createProjectService,
  definitionAt,
  fileSnapshot,
  findFunction,
  getRelationsAt,
  lineColumnAt,
  snapshotAt,
  type ProjectService,
} from "./callHierarchy.js";
import type { FunctionSnapshot, SymbolRange } from "./types.js";

/** The in-process TypeScript language service as a LanguageBackend. */
export class TsBackend implements LanguageBackend {
  private ps: ProjectService | null = null;

  constructor(readonly rootDir: string) {}

  private service(): ProjectService {
    this.ps ??= createProjectService(this.rootDir);
    return this.ps;
  }

  private offsetOf(decl: DeclRef): number | null {
    const sourceFile = this.service().program.getSourceFile(decl.fileName);
    if (!sourceFile) return null;
    return sourceFile.getPositionOfLineAndCharacter(decl.line - 1, decl.column);
  }

  async findFunction(
    name: string,
    preferred: ReadonlySet<string>,
  ): Promise<DeclRef | null> {
    const ps = this.service();
    const fn = findFunction(ps, name, preferred);
    if (!fn) return null;
    const lc = lineColumnAt(ps, fn.fileName, fn.namePos);
    return lc ? { fileName: fn.fileName, ...lc } : null;
  }

  async relationsAt(decl: DeclRef): Promise<FunctionRelations | null> {
    const offset = this.offsetOf(decl);
    if (offset === null) return null;
    return getRelationsAt(this.service(), decl.fileName, offset);
  }

  async snapshotAt(decl: DeclRef): Promise<FunctionSnapshot | null> {
    const offset = this.offsetOf(decl);
    if (offset === null) return null;
    return snapshotAt(this.service(), decl.fileName, offset);
  }

  async fileInfo(
    file: string,
  ): Promise<{ lines: string[]; symbols: SymbolRange[] } | null> {
    return fileSnapshot(this.service(), file);
  }

  async definitionAt(ref: DeclRef): Promise<DefinitionLocation | null> {
    const offset = this.offsetOf(ref);
    if (offset === null) return null;
    return definitionAt(this.service(), ref.fileName, offset);
  }

  dispose(): void {
    this.ps = null;
  }
}
