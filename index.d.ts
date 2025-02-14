// index.d.ts

declare module "hocon-config" {
  interface ParseRuntimeOptions {
    envPrefix?: string;
    parseEnv?: boolean;
    parseArgs?: boolean;
    debug?: boolean;
    // ...add more if you want them typed
  }

  interface ParseFileOptions {
    debug?: boolean;
    overrides?: Record<string, any>;
    // ...add more if you want them typed
  }

  /**
   * parse(filePath, [runtimeOptions]):
   *   1) Gather overrides from process.env + process.argv
   *   2) parseFile(...) with those overrides
   */
  export function parse(
    filePath: string,
    runtimeOptions?: ParseRuntimeOptions
  ): any;

  /**
   * parseFile(filePath, [options]):
   *   Reads .conf from disk, merges includes,
   *   environment expansions, etc. and returns an object.
   */
  export function parseFile(
    filePath: string,
    options?: ParseFileOptions
  ): Record<string, any>;

  /**
   * parseString(content, baseDir, [options]):
   *   Main parse from a string with HOCON features,
   *   returning an object.
   */
  export function parseString(
    content: string,
    baseDir?: string,
    options?: ParseFileOptions
  ): Record<string, any>;
}
