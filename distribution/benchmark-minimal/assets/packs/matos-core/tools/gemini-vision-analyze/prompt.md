Analyze a local image with Gemini vision.

Use this tool when the current agent model cannot directly inspect an image,
screenshot, plot, rendered PDF page, chart, UI capture, microscopy image, or
other visual artifact.

Input guidance:
- Always pass `imagePath` as a workspace-visible local image path.
- Always pass `context`. Include what the image is, where it came from, what
  the user is trying to decide, and any relevant text summary from the current
  task. The context helps the vision model focus on the right visual evidence.
- Pass a targeted `question` when possible. Ask for concrete observations,
  defects, labels, layout issues, plotted trends, or content extraction instead
  of a generic caption.
- Do not include API keys, tokens, credentials, or unrelated private text.

Output guidance:
- Treat the response as visual evidence, not as a replacement for domain
  validation.
- If you use the analysis in an answer, mention that it came from Gemini vision
  inspection and cross-check with files or calculations when needed.
