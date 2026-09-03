# OCR runtime assets — licences and attribution

These files are served from this application's own origin so that OCR never
contacts a third party. Each is redistributed here under its own licence.

## Tesseract.js worker and WASM cores — `tesseract/`

- `worker.min.js`, `tesseract-core-*-lstm.wasm.js`
- Copied from the installed `tesseract.js` / `tesseract.js-core` packages, so
  they always match the version in `package.json`.
- Upstream: https://github.com/naptha/tesseract.js
- Licence: **Apache-2.0**

Three core variants are present because tesseract.js feature-detects at run time
and requests exactly one of them (relaxed-SIMD, SIMD, or plain). If the detected
variant is missing it 404s and the worker fails.

## Language data — `tessdata/`

- `jpn.traineddata`, `eng.traineddata`
- Upstream: https://github.com/tesseract-ocr/tessdata_fast (taken directly from
  the canonical repository rather than a re-packaging mirror)
- Licence: **Apache-2.0**

## Japanese font — `fonts/`

- `MPLUS1p-Regular.ttf`, with the full licence text in `fonts/OFL.txt`
- Upstream: https://github.com/google/fonts/tree/main/ofl/mplus1p
- Licence: **SIL Open Font License 1.1**, which permits embedding in generated
  documents.

Chosen as the smallest static-weight Japanese TrueType available (1,758,688
bytes). It is embedded into generated PDFs only when a page actually needs OCR.

## Regenerating

```
node scripts/setup-ocr-assets.mjs
```

The Tesseract files are copied from `node_modules`; the language data and font
are downloaded from the upstreams above. Re-run after changing the tesseract.js
version so the worker and cores stay in step with the library.
