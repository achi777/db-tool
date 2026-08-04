# Screenshots

Images referenced by the root [`README.md`](../../README.md).

| File | Shows |
|---|---|
| `screenshot-main-window.png` | **Hero shot** — connection sidebar, object tree, SQL editor, results grid |
| `screenshot-view-builder.png` | The drag-and-drop visual view builder with the generated `SELECT` |

Good candidates to add next: the **ER diagram**, the **visual table designer** with its live
DDL preview, and the **nested AND/OR filter builder**.

## Rules

- **Naming:** `screenshot-<what-it-shows>.png`, lowercase, hyphenated. Never `1.png` / `2.png` —
  nobody (including future you) can tell those apart once there are six of them.
- **Size:** keep each file **under ~500 KB**. Run PNGs through an optimizer (`oxipng -o4`,
  `pngquant`, TinyPNG). Git history is permanent — a 5 MB screenshot is 5 MB forever.
- **Dimensions:** capture at a normal window size, roughly **1600×1000**. Avoid full 4K
  screenshots; GitHub scales them down and the text turns to mush.
- **Theme:** keep the whole set in the same theme (currently dark) so it looks consistent.
- **Alt text:** the README carries alt text for each image — update it if you change what an
  image shows.

## ⚠️ Before you commit a screenshot

Check that **none** of this is visible:

- Real hostnames, IP addresses or ports of servers you actually use
- Real usernames, database names or connection names
- Real customer / production data in the grid
- Anything in the window title bar, taskbar or notification area that leaks personal info

Use a throwaway demo database with obviously fake data (`customers`, `orders`, `Jane Doe`).
A screenshot committed to git cannot be un-published by deleting it later.

## Optional: light + dark variants

If you want an image to follow the viewer's GitHub theme, add `-dark` / `-light` variants
and use HTML in the README:

```html
<picture>
  <source media="(prefers-color-scheme: dark)"  srcset="docs/images/screenshot-main-window-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/screenshot-main-window-light.png">
  <img alt="DBTool main window" src="docs/images/screenshot-main-window-dark.png">
</picture>
```
