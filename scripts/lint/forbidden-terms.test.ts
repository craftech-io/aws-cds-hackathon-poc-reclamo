// The real list lives outside the repository, so these tests use made-up terms.
import { describe, expect, it } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { findTerms, listFromEnv, parseTerms, pngText, stripAccents } from "./forbidden-terms";

const TWO_WORD_BRAND = "Norte Grande";

describe("parseTerms", () => {
  it("skips blanks and comments and numbers the terms in list order", () => {
    const terms = parseTerms("# comment\n\nAcmeport\n  Norte Grande  \n");
    expect(terms.map((term) => term.index)).toEqual([1, 2]);
  });

  it("matches single words in any case and with or without accents by default", () => {
    const terms = parseTerms("Bogavante");
    expect(findTerms("f", "bogavante y BOGAVANTE y Bógavante", terms)).toHaveLength(1);
    expect(findTerms("f", "x\nBógavante", terms)).toEqual([{ source: "f", line: 2, term: 1 }]);
  });

  it("matches whole words only", () => {
    const terms = parseTerms("acme");
    expect(findTerms("f", "acmeport, acme_ltd, 2acme", terms)).toEqual([]);
    expect(findTerms("f", "(acme) acme-port", terms)).toHaveLength(1);
  });

  it("matches names of several words with their capitals and accents, so ordinary Spanish passes", () => {
    const terms = parseTerms(TWO_WORD_BRAND);
    expect(findTerms("f", "Lo reviso al día siguiente.", terms)).toEqual([]);
    expect(findTerms("f", "Viajamos al norte grande del país.", terms)).toEqual([]);
    expect(findTerms("f", "Viajamos al Norte grande del país.", terms)).toEqual([]);
    expect(findTerms("f", `Bienvenido a ${TWO_WORD_BRAND}`, terms)).toHaveLength(1);
    expect(findTerms("f", `Bienvenido a ${TWO_WORD_BRAND.replace(" ", "\t ")}`, terms)).toHaveLength(1);
  });

  it("honours per-term flags", () => {
    const exact = parseTerms("Norte Grande|ia");
    expect(findTerms("f", "norte grandé", exact)).toHaveLength(1);
    const caseSensitiveWord = parseTerms("Delta|ce");
    expect(findTerms("f", "delta", caseSensitiveWord)).toEqual([]);
    expect(findTerms("f", "Delta", caseSensitiveWord)).toHaveLength(1);
  });

  it("escapes regular-expression characters of a term", () => {
    expect(findTerms("f", "a.b", parseTerms("a+b"))).toEqual([]);
    expect(findTerms("f", "x a+b y", parseTerms("a+b"))).toHaveLength(1);
  });

  it("strips accents with Unicode normalization", () => {
    expect(stripAccents("Árbol pingüino canción")).toBe("Arbol pinguino cancion");
  });
});

describe("listFromEnv [FL-110]", () => {
  it("fails closed in CI when the list is absent or empty", () => {
    expect(listFromEnv({ CI: "true" })).toMatchObject({ ok: false, fatal: true });
    expect(listFromEnv({ CI: "true", FORBIDDEN_TERMS: "  \n# only a comment\n" })).toMatchObject({ ok: false, fatal: true });
  });

  it("only warns on a local run without a list", () => {
    expect(listFromEnv({})).toMatchObject({ ok: false, fatal: false });
  });

  it("never puts a term in its messages", () => {
    const status = listFromEnv({ CI: "true", FORBIDDEN_TERMS: "" });
    expect(status.ok ? "" : status.message).not.toMatch(/Acme/);
    expect(listFromEnv({ FORBIDDEN_TERMS: "Acmeport" })).toMatchObject({ ok: true });
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

describe("pngText [FL-110]", () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("reads the keyword and text of tEXt, zTXt and iTXt chunks, where an image hides its metadata", () => {
    const png = Buffer.concat([
      signature,
      chunk("IHDR", Buffer.alloc(13)),
      chunk("tEXt", Buffer.from("Author\0Norte Grande Studio", "latin1")),
      chunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0", "latin1"), deflateSync(Buffer.from("made for Acme"))])),
      chunk("iTXt", Buffer.concat([Buffer.from("Title\0\0\0es\0Título\0", "utf8"), Buffer.from("captura de Acme", "utf8")])),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const text = pngText(png);
    expect(text).toContain("Norte Grande Studio");
    expect(text).toContain("made for Acme");
    expect(text).toContain("captura de Acme");
    expect(findTerms("a.png", text, parseTerms("acme"))).toHaveLength(2);
  });

  it("returns nothing for a file that is not a PNG or a truncated one", () => {
    expect(pngText(Buffer.from("not a png"))).toBe("");
    expect(pngText(Buffer.concat([signature, Buffer.from([0, 0, 0, 99, 0x74, 0x45])]))).toBe("");
  });
});
