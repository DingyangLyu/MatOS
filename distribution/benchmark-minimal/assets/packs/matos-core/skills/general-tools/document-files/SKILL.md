---
name: document-files
description: Read research documents and tabular data with local, independently installed tools; create ordinary Office files when requested.
---

# Research documents and tables

Keep original inputs unchanged. Save extracted text, tables, figures and reports in the task workspace, and record the source file and page/sheet used for each scientific claim.

## Read documents

Use the native document_parse tool for local PDF, DOCX, HTML and plain-text files. Its input is an object with path, optional max_chars and optional start_char. Continue from next_start_char when the response is truncated. The parser reports missing optional dependencies rather than inventing document contents.

For a PDF with selectable text, a local fallback is:

```bash
pdftotext -layout input.pdf extracted.txt
```

For plots, spectra, scanned pages or layout-sensitive evidence, render the relevant pages with an installed PDF renderer and inspect the resulting images. Text extraction alone does not establish values from a graph. Keep page numbers and units with extracted values.

## Read tabular data

Use Python's csv/json modules for CSV and JSON, and a separately installed openpyxl or pandas for XLSX. Preserve column names, units, missing-value conventions and sheet selection. A workbook read with data_only=True returns cached formula values; it does not recalculate formulas. Verify any numerical result with the calculation actually used in the task.

## Create reports

Prefer Markdown plus original plots for benchmark submissions. Respect the benchmark's prescribed report and answer paths. When the user requests Office files, independently installed python-docx, python-pptx or openpyxl provide real DOCX, PPTX and XLSX writers. Validate the saved file by opening it with the matching library and, when layout matters, render it with an available office application before delivery.

This procedure is authored for MatOS. It does not include third-party document-skill bundles. Optional libraries and command-line programs retain their own licenses and must be installed separately.
