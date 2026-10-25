// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import {
  DesignFilesPanel,
  type DesignFilesNavState,
} from "../../src/components/DesignFilesPanel";
import type {
  ProjectFile,
  ProjectFileKind,
  ProjectFolder,
} from "../../src/types";
import { VISUAL_STABILITY_STORAGE_KEY } from "../../src/utils/visualStability";

function folder(path: string): ProjectFolder {
  return {
    name: path.split("/").pop() ?? path,
    path,
    type: "dir",
    size: 0,
    mtime: 1700000000,
  };
}

// Stub localStorage so the component's view-state persistence writes to an
// in-memory store. Cleared in beforeEach so no test bleeds state into the next.
const lsStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => lsStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    lsStore.set(key, value);
  },
  removeItem: (key: string) => {
    lsStore.delete(key);
  },
  clear: () => {
    lsStore.clear();
  },
});

beforeEach(() => {
  lsStore.clear();
});

function extForKind(kind: ProjectFileKind): string {
  if (kind === "html") return "html";
  if (kind === "image") return "png";
  if (kind === "text") return "txt";
  if (kind === "code") return "ts";
  if (kind === "pdf") return "pdf";
  return "bin";
}

function file(
  overrides: Partial<ProjectFile> & Pick<ProjectFile, "name">,
): ProjectFile {
  return {
    path: overrides.name,
    type: "file",
    size: 1024,
    mtime: Date.now(),
    kind: "html",
    mime: "text/html",
    ...overrides,
  };
}

function generateFiles(count: number): ProjectFile[] {
  const kinds: ProjectFileKind[] = [
    "html",
    "image",
    "text",
    "code",
    "pdf",
  ];
  return Array.from({ length: count }, (_, i) => {
    const kind = kinds[i % kinds.length]!;
    return file({
      name: `file-${i + 1}.${extForKind(kind)}`,
      kind,
      size: 1024 * (i + 1),
      mtime: Date.now() - i * 60_000,
      mime: "text/plain",
    });
  });
}

function renderPanel(
  files: ProjectFile[],
  overrides: Partial<ComponentProps<typeof DesignFilesPanel>> = {},
) {
  const onOpenFile = vi.fn();
  const onDeleteFiles = vi.fn();
  const onClearUploadError = vi.fn();
  const result = render(
    <DesignFilesPanel
      projectId="test-project"
      files={files}
      onRefreshFiles={vi.fn()}
      onOpenFile={onOpenFile}
      onRenameFile={vi.fn()}
      onDeleteFile={vi.fn()}
      onDeleteFiles={onDeleteFiles}
      onUpload={vi.fn()}
      onUploadFiles={vi.fn()}
      onPaste={vi.fn()}
      onClearUploadError={onClearUploadError}
      {...overrides}
    />,
  );
  return { ...result, onDeleteFiles, onOpenFile, onClearUploadError };
}

describe('bounded large file listings', () => {
  afterEach(cleanup);
  const manyFiles = () => Array.from({ length: 601 }, (_, i) => file({ name: `work/item-${String(i).padStart(4, '0')}.txt`, kind: 'text', mtime: 1000 - i }));

  it('bounds root list DOM while keeping later files reachable and openable', () => {
    const { container, onOpenFile } = renderPanel(manyFiles());
    expect(container.querySelectorAll('[data-testid^="design-file-row-"]').length).toBeLessThanOrEqual(200);
    const next = screen.getByTestId('design-files-next-page');
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    const last = screen.getByTestId('design-file-row-work/item-0600.txt');
    fireEvent.doubleClick(last.querySelector('.df-row-icon')!);
    expect(onOpenFile).toHaveBeenCalledWith('work/item-0600.txt');
    expect(screen.getByTestId('design-files-next-page')).toBeDisabled();
  });

  it('bounds expanded tree DOM and preserves all directory descendants', () => {
    lsStore.set('od-design-files-view', 'tree');
    const { container } = renderPanel(manyFiles(), { navState: { currentDir: '', expandedDirs: ['work'], preview: null } });
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThanOrEqual(200);
    fireEvent.click(screen.getByTestId('design-files-next-page'));
    expect(container.querySelector('[data-tree-path="file:work/item-0199.txt"]')).toBeTruthy();
    expect(container.querySelector('[data-tree-path="file:work/item-0000.txt"]')).toBeNull();
  });
});

function sectionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".df-section-label"),
  ).map((el) => el.textContent ?? "");
}

describe("DesignFilesPanel sections", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps load-more and page navigation inside one non-overlapping sticky footer", () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderPanel(generateFiles(1000), {
      filePaging: { total: 1005, hasMore: true, loading: false, error: null, loadMore },
    });
    const more = screen.getByTestId('design-files-load-more');
    expect(more.parentElement).toBe(screen.getByTestId('design-files-paging-footer'));
    expect(screen.getByTestId('design-files-pagination').parentElement).toBe(more.parentElement);
    fireEvent.click(more.querySelector('button')!);
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it("does not show grouping, sort, filter, or pagination chrome", () => {
    renderPanel(generateFiles(60));

    expect(screen.queryByRole("group", { name: "Group by" })).toBeNull();
    expect(document.querySelector(".df-table")).toBeNull();
    expect(document.querySelector(".df-th-sortable")).toBeNull();
    expect(document.querySelector(".df-kind-filter")).toBeNull();
    expect(document.querySelector(".df-pagination")).toBeNull();
    expect(document.querySelector(".df-page-btn")).toBeNull();
  });

  it("renders a single-line toolbar with file actions and no up/refresh buttons", () => {
    renderPanel([file({ name: "page.html", kind: "html" })]);

    expect(document.querySelector(".df-topbar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(document.querySelector(".df-up-btn")).toBeNull();
    expect(document.querySelector(".df-refresh-control")).toBeNull();
    expect(screen.getByTestId("design-files-upload-trigger")).toBeTruthy();
  });

  it("shows prioritized project starter actions in the empty state", () => {
    const onOpenBrowser = vi.fn();
    const onPaste = vi.fn();

    renderPanel([], {
      onOpenBrowser,
      onPaste,
    });

    fireEvent.click(screen.getByTestId("design-files-empty-open-browser"));
    fireEvent.click(screen.getByTestId("design-files-empty-create-document"));

    expect(onOpenBrowser).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("design-files-empty-create-document").textContent,
    ).toContain("Create document");
    expect(
      screen.queryByRole("button", { name: "Create new design system" }),
    ).toBeNull();
  });

  it("groups files into semantic sections by category", () => {
    renderPanel([
      file({ name: "page.html", kind: "html", mime: "text/html" }),
      file({ name: "chart.png", kind: "image", mime: "image/png" }),
    ]);

    const labels = sectionLabels();
    expect(labels.some((text) => text.includes("Pages"))).toBe(true);
    expect(labels.some((text) => text.includes("Images"))).toBe(true);
    expect(screen.getByTestId("design-file-row-page.html")).toBeTruthy();
    expect(screen.getByTestId("design-file-row-chart.png")).toBeTruthy();
  });

  it("splits stylesheets into their own section with a Stylesheet subtitle", () => {
    renderPanel([
      file({ name: "styles.css", kind: "code", mime: "text/css" }),
      file({ name: "app.ts", kind: "code", mime: "text/typescript" }),
    ]);

    const labels = sectionLabels();
    expect(labels.some((text) => text.includes("Stylesheets"))).toBe(true);
    expect(labels.some((text) => text.includes("Scripts"))).toBe(true);

    const cssRow = screen.getByTestId("design-file-row-styles.css");
    expect(cssRow.querySelector(".df-row-sub")?.textContent).toBe("Stylesheet");
    const tsRow = screen.getByTestId("design-file-row-app.ts");
    expect(tsRow.querySelector(".df-row-sub")?.textContent).toBe("Script");
  });

  it('shows the file size beside the modified time while preserving the type subtitle', () => {
    renderPanel([file({ name: 'chart.png', kind: 'image', size: 4096 })]);

    const row = screen.getByTestId('design-file-row-chart.png');
    expect(row.querySelector('.df-row-sub')?.textContent).toBe('Image');
    expect(row.querySelector('.df-row-size')?.textContent).toBe('4.0 KB');
  });

  it("shows the upload hint in the footer while idle", () => {
    renderPanel([file({ name: "page.html", kind: "html" })]);

    expect(document.querySelector(".df-drop-hint")).toBeTruthy();
    expect(document.querySelector(".df-useful-info")).toBeNull();
  });

  it("types out the first useful-info tip in the footer while the agent runs", async () => {
    localStorage.setItem(VISUAL_STABILITY_STORAGE_KEY, "1");
    renderPanel([file({ name: "page.html", kind: "html" })], { running: true });

    expect(document.querySelector(".df-drop-hint")).toBeNull();
    expect(document.querySelector(".df-useful-info-label")?.textContent).toBe(
      "Useful info",
    );
    // The tip types in character by character, so wait for the first word.
    await waitFor(() =>
      expect(
        document.querySelector(".df-useful-info-tip")?.textContent,
      ).toContain("Double-click"),
    );
  });
});

describe("DesignFilesPanel large list", () => {
  afterEach(() => cleanup());

  it("bounds the initial page and keeps the remaining files reachable", () => {
    const { container } = renderPanel(generateFiles(500));
    expect(container.querySelectorAll(".df-file-row").length).toBe(200);
    fireEvent.click(screen.getByTestId('design-files-next-page'));
    expect(container.querySelectorAll(".df-file-row").length).toBe(200);
    fireEvent.click(screen.getByTestId('design-files-next-page'));
    expect(container.querySelectorAll(".df-file-row").length).toBe(100);
  });

  it("renders 500 files within a reasonable time", () => {
    const files = generateFiles(500);
    const start = performance.now();
    renderPanel(files);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("DesignFilesPanel selection", () => {
  afterEach(() => cleanup());

  it("shows the batch bar and passes every selected file to batch delete", () => {
    const files = generateFiles(3);
    const { container, onDeleteFiles } = renderPanel(files);
    const rows = Array.from(container.querySelectorAll(".df-file-row"));

    const firstName = rows[0]!
      .getAttribute("data-testid")!
      .replace(/^design-file-row-/, "");
    const secondName = rows[1]!
      .getAttribute("data-testid")!
      .replace(/^design-file-row-/, "");
    fireEvent.click(rows[0]!.querySelector(".df-row-check")!);
    fireEvent.click(rows[1]!.querySelector(".df-row-check")!);

    expect(
      container.querySelector('[data-testid="design-files-batch-bar"]'),
    ).toBeTruthy();

    fireEvent.click(
      container.querySelector('[data-testid="design-files-batch-delete"]')!,
    );
    expect(onDeleteFiles).toHaveBeenCalledTimes(1);
    expect(onDeleteFiles).toHaveBeenCalledWith([firstName, secondName]);
  });

  it("does not preview or open files from row controls", () => {
    const files = generateFiles(1);
    const { container, onOpenFile } = renderPanel(files);
    const row = container.querySelector(".df-file-row")!;

    fireEvent.click(row.querySelector(".df-row-check")!);
    expect(
      container.querySelector('[data-testid="design-file-preview"]'),
    ).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();

    fireEvent.click(row.querySelector(".df-row-menu")!);
    expect(
      container.querySelector('[data-testid="design-file-preview"]'),
    ).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("copies the local file path from the row menu", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      const { container } = renderPanel([
        file({
          name: "alpha.html",
          localPath: "/tmp/open-design/projects/test-project/alpha.html",
        }),
      ]);

      fireEvent.click(screen.getByTestId("design-file-menu-alpha.html"));
      fireEvent.click(
        screen.getByRole("button", { name: "Copy local file path" }),
      );

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(
          "/tmp/open-design/projects/test-project/alpha.html",
        );
      });
      expect(
        container.querySelector('[data-testid="design-file-preview"]'),
      ).toBeNull();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("uses non-control row targets to preview and open", () => {
    const files = generateFiles(1);
    const { container, onOpenFile } = renderPanel(files);
    const row = container.querySelector(".df-file-row")!;

    fireEvent.click(row.querySelector(".df-row-icon")!);
    expect(
      container.querySelector('[data-testid="design-file-preview"]')
        ?.textContent,
    ).toContain("file-1.html");

    fireEvent.doubleClick(row.querySelector(".df-row-name-btn")!);
    expect(onOpenFile).toHaveBeenCalledWith("file-1.html");
    onOpenFile.mockClear();

    fireEvent.doubleClick(row.querySelector(".df-row-time")!);
    expect(onOpenFile).toHaveBeenCalledWith("file-1.html");
  });
});

describe("DesignFilesPanel preview", () => {
  afterEach(() => cleanup());

  it("shows the file extension in the preview stats", () => {
    const { container } = renderPanel([
      file({ name: "chart.png", kind: "image", size: 4096 }),
    ]);
    fireEvent.click(container.querySelector(".df-file-row .df-row-icon")!);

    const stats =
      container.querySelector(".df-preview-stats")?.textContent ?? "";
    expect(stats).toContain("PNG");
  });

});

describe("DesignFilesPanel directory navigation", () => {
  afterEach(() => {
    cleanup();
  });

  it("collapses nested files into a single folder row at root with correct descendant count", () => {
    renderPanel([
      file({ name: "assets/logo.png", kind: "image" }),
      file({ name: "assets/icons/star.svg", kind: "image" }),
    ]);

    const dirRows = document.querySelectorAll(".df-dir-row");
    expect(dirRows.length).toBe(1);
    expect(dirRows[0]!.textContent).toContain("assets");
    expect(dirRows[0]!.textContent).toContain("2");
  });

  it("pins folders into a Folders section", () => {
    renderPanel([
      file({ name: "assets/logo.png", kind: "image" }),
      file({ name: "top.html", kind: "html" }),
    ]);

    expect(sectionLabels().some((text) => text.includes("Folders"))).toBe(true);
  });

  it("clicking a folder row navigates into it and shows only basenames and nested dirs", () => {
    renderPanel([
      file({ name: "assets/logo.png", kind: "image" }),
      file({ name: "assets/icons/star.svg", kind: "image" }),
    ]);

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);

    expect(document.querySelector(".df-breadcrumbs")).toBeTruthy();
    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "assets",
    );

    const fileRow = screen.getByTestId("design-file-row-assets/logo.png");
    expect(fileRow.querySelector(".df-row-name")?.textContent).toBe("logo.png");
    expect(fileRow.querySelector(".df-row-name")?.textContent).not.toContain(
      "assets/",
    );

    const dirRows = document.querySelectorAll(".df-dir-row");
    expect(dirRows.length).toBe(1);
    expect(dirRows[0]!.textContent).toContain("icons");
  });

  it("always renders the root breadcrumb on the default-root view", () => {
    // Regression: managed-storage projects have currentDir==='' and no
    // rootDirName, which previously collapsed the whole breadcrumb nav to null
    // and left the toolbar blank on the left for the most common path. The root
    // crumb must always render, falling back to the t('designFiles.crumbs')
    // label when no rootDirName exists.
    renderPanel([file({ name: "top.html", kind: "html" })]);

    expect(document.querySelector(".df-breadcrumbs")).toBeTruthy();
    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "Project",
    );
  });

  it("shows rootDirName as the root breadcrumb when one is provided", () => {
    renderPanel([file({ name: "top.html", kind: "html" })], {
      rootDirName: "my-folder",
    });

    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "my-folder",
    );
  });

  it("clicking the root breadcrumb navigates back to root", () => {
    renderPanel([
      file({ name: "assets/logo.png", kind: "image" }),
      file({ name: "top.html", kind: "html" }),
    ]);

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    expect(document.querySelector(".df-breadcrumbs")).toBeTruthy();

    fireEvent.click(document.querySelector(".df-breadcrumb-btn")!);

    expect(
      document.querySelector(".df-breadcrumb-current")?.textContent,
    ).not.toBe("assets");
    expect(screen.getByTestId("design-file-row-top.html")).toBeTruthy();
    expect(document.querySelectorAll(".df-dir-row").length).toBe(1);
  });

  it("includes subdirectory files in the flat root-level list", () => {
    renderPanel([
      file({ name: "assets/logo.png", kind: "image" }),
      file({ name: "top.html", kind: "html" }),
    ]);

    expect(document.querySelectorAll(".df-dir-row").length).toBe(1);
    expect(screen.getByTestId("design-file-row-assets/logo.png")).toBeTruthy();
    expect(screen.getByTestId("design-file-row-top.html")).toBeTruthy();
  });

  it("preserves the current directory when remounted with navState from a previous render", () => {
    let saved: DesignFilesNavState | undefined;

    function makePanel(nav?: DesignFilesNavState) {
      return (
        <DesignFilesPanel
          projectId="test-project"
          files={[
            file({ name: "assets/logo.png", kind: "image" }),
            file({ name: "top.html", kind: "html" }),
          ]}
          navState={nav}
          onNavStateChange={(state) => {
            saved = state;
          }}
          onRefreshFiles={vi.fn()}
          onOpenFile={vi.fn()}
          onRenameFile={vi.fn()}
          onDeleteFile={vi.fn()}
          onDeleteFiles={vi.fn()}
          onUpload={vi.fn()}
          onUploadFiles={vi.fn()}
          onPaste={vi.fn()}
            />
      );
    }

    const { unmount } = render(makePanel());

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "assets",
    );

    unmount();
    render(makePanel(saved));

    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "assets",
    );
    expect(screen.getByTestId("design-file-row-assets/logo.png")).toBeTruthy();
  });

  it("restores tree expansion and the selected row when remounted with navState", () => {
    let saved: DesignFilesNavState | undefined;

    function makePanel(nav?: DesignFilesNavState) {
      return (
        <DesignFilesPanel
          projectId="test-project"
          files={[
            file({ name: "assets/logo.png", kind: "image" }),
            file({ name: "top.html", kind: "html" }),
          ]}
          navState={nav}
          onNavStateChange={(state) => {
            saved = state;
          }}
          onRefreshFiles={vi.fn()}
          onOpenFile={vi.fn()}
          onRenameFile={vi.fn()}
          onDeleteFile={vi.fn()}
          onDeleteFiles={vi.fn()}
          onUpload={vi.fn()}
          onUploadFiles={vi.fn()}
          onPaste={vi.fn()}
            />
      );
    }

    const { unmount } = render(makePanel());

    // Switch to tree view, expand assets/, select the file inside.
    fireEvent.click(screen.getByTestId("df-view-mode-toggle"));
    fireEvent.click(screen.getByTestId("design-tree-dir-assets"));
    fireEvent.click(screen.getByTestId("design-tree-file-assets/logo.png"));
    expect(saved?.expandedDirs).toContain("assets");
    expect(saved?.preview).toBe("assets/logo.png");

    unmount();
    render(makePanel(saved));

    // The expanded directory renders its children again without any clicks,
    // and the previously selected row is still highlighted.
    const restoredRow = screen.getByTestId("design-tree-file-assets/logo.png");
    expect(restoredRow.classList.contains("active")).toBe(true);
  });

  it("navigates up one level via the parent breadcrumb", () => {
    renderPanel([file({ name: "assets/icons/star.svg", kind: "image" })]);

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "icons",
    );

    const crumbs = Array.from(document.querySelectorAll(".df-breadcrumb-btn"));
    fireEvent.click(crumbs[crumbs.length - 1]!);
    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "assets",
    );
  });

  it("clears selection when navigating into or out of a directory", () => {
    renderPanel([
      file({ name: "assets/logo.png", kind: "image" }),
      file({ name: "top.html", kind: "html" }),
    ]);

    const topRow = screen.getByTestId("design-file-row-top.html");
    fireEvent.click(topRow.querySelector(".df-row-check")!);
    expect(topRow.classList.contains("selected")).toBe(true);

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    expect(document.querySelectorAll(".df-file-row.selected").length).toBe(0);

    fireEvent.click(document.querySelector(".df-breadcrumb-btn")!);
    expect(document.querySelectorAll(".df-file-row.selected").length).toBe(0);
  });

  it("resets currentDir automatically when all files in the current subdirectory are removed", () => {
    function makePanel(files: ProjectFile[]) {
      return (
        <DesignFilesPanel
          projectId="test-project"
          files={files}
          onRefreshFiles={vi.fn()}
          onOpenFile={vi.fn()}
          onRenameFile={vi.fn()}
          onDeleteFile={vi.fn()}
          onDeleteFiles={vi.fn()}
          onUpload={vi.fn()}
          onUploadFiles={vi.fn()}
          onPaste={vi.fn()}
            />
      );
    }

    const { rerender } = render(
      makePanel([
        file({ name: "assets/logo.png", kind: "image" }),
        file({ name: "top.html", kind: "html" }),
      ]),
    );

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    expect(document.querySelector(".df-breadcrumb-current")?.textContent).toBe(
      "assets",
    );

    rerender(makePanel([file({ name: "top.html", kind: "html" })]));

    expect(
      document.querySelector(".df-breadcrumb-current")?.textContent,
    ).not.toBe("assets");
    expect(screen.getByTestId("design-file-row-top.html")).toBeTruthy();
  });
});

describe("DesignFilesPanel current-directory sync", () => {
  afterEach(() => cleanup());

  it("reports the active folder so new files are created under it, not the root", () => {
    const onCurrentDirChange = vi.fn();
    renderPanel(
      [
        file({ name: "top.html", kind: "html" }),
        file({ name: "assets/logo.png", kind: "image" }),
      ],
      { onCurrentDirChange },
    );
    // Mounts at the root.
    expect(onCurrentDirChange).toHaveBeenLastCalledWith("");
    // Navigate into the folder — the parent must learn the new target dir, or
    // upload / paste would create at the project root (#3358 regression).
    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    expect(onCurrentDirChange).toHaveBeenLastCalledWith("assets");
  });
});

describe("DesignFilesPanel persisted (empty) folders", () => {
  afterEach(() => cleanup());

  it("shows an empty persisted folder that has no files under it", () => {
    // Only a root file + an empty persisted folder; the folder must still
    // appear (it would vanish if we derived dirs from file paths alone).
    renderPanel([file({ name: "top.html", kind: "html" })], {
      folders: [folder("assets")],
    });
    const dirRows = [...document.querySelectorAll(".df-dir-row")];
    expect(dirRows.some((r) => r.textContent?.includes("assets"))).toBe(true);
  });

  it("surfaces a nested empty persisted folder after navigating into its parent", () => {
    renderPanel([], { folders: [folder("assets"), folder("assets/icons")] });
    // Zero files, but the persisted folder still renders the tree (not the
    // empty state), so 'assets' is navigable at the root.
    const rootDirs = [
      ...document.querySelectorAll(".df-dir-row .df-row-name"),
    ].map((e) => e.textContent);
    expect(rootDirs).toContain("assets");
    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    const nestedDirs = [
      ...document.querySelectorAll(".df-dir-row .df-row-name"),
    ].map((e) => e.textContent);
    expect(nestedDirs).toContain("icons");
  });
});

describe("DesignFilesPanel filesystem operations", () => {
  afterEach(() => cleanup());

  it("creates a folder under the current directory from the toolbar button", async () => {
    const onCreateFolder = vi.fn(async () => true);
    renderPanel([file({ name: "top.html", kind: "html" })], { onCreateFolder });

    fireEvent.click(screen.getByTestId("design-files-new-folder"));
    const input = screen.getByTestId(
      "design-files-new-folder-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "results" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith("results"));
    // Input row dismisses after a successful create.
    await waitFor(() =>
      expect(screen.queryByTestId("design-files-new-folder-input")).toBeNull(),
    );
  });

  it("prefixes the new folder with the directory being viewed", async () => {
    const onCreateFolder = vi.fn(async () => true);
    renderPanel([file({ name: "assets/logo.png", kind: "image" })], {
      onCreateFolder,
    });

    fireEvent.click(document.querySelector(".df-dir-row .df-row-name-btn")!);
    fireEvent.click(screen.getByTestId("design-files-new-folder"));
    const input = screen.getByTestId(
      "design-files-new-folder-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "icons" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onCreateFolder).toHaveBeenCalledWith("assets/icons"),
    );
  });

  it("shows the new-folder toolbar button only when the handler is wired", () => {
    renderPanel([file({ name: "top.html", kind: "html" })]);
    expect(screen.queryByTestId("design-files-new-folder")).toBeNull();
  });

  it("renames a folder inline through its row menu", async () => {
    const onRenameFolder = vi.fn(async () => true);
    renderPanel([file({ name: "runs/relax.in", kind: "text" })], {
      onRenameFolder,
      onDeleteFolder: vi.fn(async () => true),
    });

    fireEvent.click(screen.getByTestId("design-dir-menu-runs"));
    fireEvent.click(screen.getByTestId("design-dir-rename-runs"));

    const input = document.querySelector(
      ".df-dir-row .df-rename-input",
    ) as HTMLInputElement;
    expect(input.value).toBe("runs");
    fireEvent.change(input, { target: { value: "calculations" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onRenameFolder).toHaveBeenCalledWith("runs", "calculations"),
    );
  });

  it("deletes a folder through its row menu", async () => {
    const onDeleteFolder = vi.fn(async () => true);
    renderPanel([file({ name: "runs/relax.in", kind: "text" })], {
      onDeleteFolder,
    });

    fireEvent.click(screen.getByTestId("design-dir-menu-runs"));
    fireEvent.click(screen.getByTestId("design-dir-delete-runs"));

    await waitFor(() => expect(onDeleteFolder).toHaveBeenCalledWith("runs"));
  });

  it("moves a file to a chosen folder via the row menu move dialog", async () => {
    const onRenameFile = vi.fn(async (from: string, to: string) =>
      file({ name: to, kind: "text" }),
    );
    renderPanel(
      [
        file({ name: "relax.in", kind: "text" }),
        file({ name: "archive/old.out", kind: "text" }),
      ],
      { onRenameFile },
    );

    fireEvent.click(screen.getByTestId("design-file-menu-relax.in"));
    fireEvent.click(screen.getByTestId("design-file-move-relax.in"));

    const select = screen.getByTestId(
      "design-files-move-dest",
    ) as HTMLSelectElement;
    // Folder derived from the other file's path is offered as a destination.
    expect([...select.options].map((o) => o.value)).toContain("archive");
    fireEvent.change(select, { target: { value: "archive" } });
    fireEvent.click(screen.getByTestId("design-files-move-confirm"));

    await waitFor(() =>
      expect(onRenameFile).toHaveBeenCalledWith("relax.in", "archive/relax.in"),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("design-files-move-dialog")).toBeNull(),
    );
  });

  it("moves a batch selection into a new folder created from the dialog", async () => {
    const onCreateFolder = vi.fn(async () => true);
    const onRenameFile = vi.fn(async (from: string, to: string) =>
      file({ name: to, kind: "text" }),
    );
    renderPanel(
      [
        file({ name: "a.in", kind: "text" }),
        file({ name: "b.out", kind: "text" }),
      ],
      { onCreateFolder, onRenameFile },
    );

    for (const name of ["a.in", "b.out"]) {
      const row = screen.getByTestId(`design-file-row-${name}`);
      fireEvent.click(row.querySelector(".df-row-check")!);
    }
    fireEvent.click(screen.getByTestId("design-files-batch-move"));

    const select = screen.getByTestId(
      "design-files-move-dest",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__new__" } });
    const input = screen.getByTestId(
      "design-files-move-new-folder",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "batch1" } });
    fireEvent.click(screen.getByTestId("design-files-move-confirm"));

    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith("batch1"));
    await waitFor(() => {
      expect(onRenameFile).toHaveBeenCalledWith("a.in", "batch1/a.in");
      expect(onRenameFile).toHaveBeenCalledWith("b.out", "batch1/b.out");
    });
  });
});
