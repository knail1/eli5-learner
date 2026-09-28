/**
 * Text fixtures that are awkward to hand-write because of their encodings (13 §5.1):
 * bom-utf16.txt (UTF-16LE with BOM) and cp1252.txt (windows-1252 bytes, no BOM).
 * notes.md, plain.txt and sales.csv are hand-written.
 */

export function bomUtf16(): Uint8Array {
  const text = 'Café menu review\r\n\r\nThe new espresso blend scored 4.5 out of 5.\r\nCustomers asked for oat milk.\r\n';
  const body = Buffer.from(text, 'utf16le');
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
}

/** windows-1252 has characters outside latin1 (e.g. — and €), so map them by hand. */
export function cp1252(): Uint8Array {
  const text = 'Résumé of the naïve café plan — €1,200 budget\n\n“Smart quotes” survive the round trip.\n';
  const map: Record<string, number> = { '—': 0x97, '€': 0x80, '“': 0x93, '”': 0x94 };
  return new Uint8Array([...text].map((ch) => map[ch] ?? ch.charCodeAt(0)));
}
