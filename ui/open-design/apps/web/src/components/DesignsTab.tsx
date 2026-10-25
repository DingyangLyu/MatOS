import type { CSSProperties } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@open-design/components";
import { useI18n, useT } from "../i18n";
import { fetchProjectPreviewFiles, projectFileUrl } from "../providers/registry";
import type {
	Project,
	ProjectDisplayStatus,
	SkillSummary,
} from "../types";
import { AnimatePresence } from "motion/react";
import { Icon } from "./Icon";
import { Toast } from "./Toast";
import { visibleProjectDirectory } from "../utils/projectWorkspace";
import projectCardStyles from "./ProjectPreviewCard.module.css";
import { ProjectCardContents } from "./ProjectCardContents";

type SubTab = "recent" | "yours";
type ViewMode = "grid" | "kanban";

type DesignListItem = { type: "project"; project: Project; updatedAt: number; createdAt: number };

const DESIGNS_VIEW_STORAGE_KEY = "od:designs:view";
const PROJECTS_AUTO_REFRESH_MS = 15000;

export const STATUS_ORDER = [
	"not_started",
	"running",
	"awaiting_input",
	"succeeded",
	"failed",
	"canceled",
] as const satisfies readonly ProjectDisplayStatus[];

export const STATUS_LABEL_KEYS = {
	not_started: "designs.status.notStarted",
	queued: "designs.status.queued",
	running: "designs.status.running",
	awaiting_input: "designs.status.awaitingInput",
	succeeded: "designs.status.succeeded",
	failed: "designs.status.failed",
	canceled: "designs.status.canceled",
} as const satisfies Record<
	ProjectDisplayStatus,
	Parameters<ReturnType<typeof useT>>[0]
>;

interface Props {
	nativeMatOSChat?: boolean;
	projects: Project[];
	skills: SkillSummary[];
	onOpen: (id: string) => void;
	onDelete: (id: string) => Promise<boolean | void> | boolean | void;
	onDuplicate?: (id: string) => Promise<void> | void;
	onRename?: (id: string, name: string) => void;
	onNewProject?: () => void;
	onRefresh?: () => Promise<void> | void;
	isActive?: boolean;
}

export function DesignsTab({
	nativeMatOSChat = false,
	projects,
	skills,
	onOpen,
	onDelete,
	onDuplicate,
	onRename,
	onNewProject,
	onRefresh,
	isActive = true,
}: Props) {
	const renameTitleId = useId();
	const confirmTitleId = useId();
	const { locale, t } = useI18n();
	const zh = locale.toLowerCase().startsWith("zh");
	const [filter, setFilter] = useState("");
	const [sub, setSub] = useState<SubTab>("recent");
	const [coverByProject, setCoverByProject] = useState<
		Record<string, { kind: "html" | "image" | "video" | "logo"; name: string } | null>
	>({});
	const [failedCovers, setFailedCovers] = useState<Record<string, string>>({});
	const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
	const [selectMode, setSelectMode] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const toastIdRef = useRef(0);
	const [designsToast, setDesignsToast] = useState<{
		id: number;
		message: string;
		role?: "status" | "alert";
		tone?: "default" | "success" | "error";
	} | null>(null);
	const [projectsRefreshing, setProjectsRefreshing] = useState(false);
	const menuContainerRef = useRef<HTMLDivElement | null>(null);
	const projectsRefreshInFlightRef = useRef(false);
	const [renameTarget, setRenameTarget] = useState<{ id: string; original: string } | null>(null);
	const [renameInput, setRenameInput] = useState("");
	const [confirmTarget, setConfirmTarget] = useState<{
		title: string;
		message: string;
		confirmLabel: string;
		onConfirm: () => void;
	} | null>(null);
	const [view, setView] = useState<ViewMode>(() => {
		if (typeof window === "undefined") return "grid";
		try {
			const storedView = window.localStorage.getItem(DESIGNS_VIEW_STORAGE_KEY);
			return storedView === "grid" || storedView === "kanban"
				? storedView
				: "grid";
		} catch {
			return "grid";
		}
	});

	useEffect(() => {
		let cancelled = false;
		if (projects.length === 0 || nativeMatOSChat) {
			setCoverByProject({});
			return;
		}
		void Promise.all(
			projects.map(async (project) => {
				if (project.metadata?.entryFile) return [project.id, null] as const;
				let files: Awaited<ReturnType<typeof fetchProjectPreviewFiles>>;
				try {
					files = await fetchProjectPreviewFiles(project.id);
				} catch {
					return [project.id, null] as const;
				}
				const html =
					files.find((f) => (f.path ?? f.name) === "index.html") ??
					files
						.filter((f) => f.kind === "html")
						.sort((a, b) => b.mtime - a.mtime)[0];
				if (html) {
					return [
						project.id,
						{ kind: "html" as const, name: html.path ?? html.name },
					] as const;
				}
				const image = files
					.filter((f) => f.kind === "image")
					.sort((a, b) => b.mtime - a.mtime)[0];
				if (image) {
					return [
						project.id,
						{ kind: "image" as const, name: image.path ?? image.name },
					] as const;
				}
				const video = files
					.filter((f) => f.kind === "video")
					.sort((a, b) => b.mtime - a.mtime)[0];
				if (video) {
					return [
						project.id,
						{ kind: "video" as const, name: video.path ?? video.name },
					] as const;
				}
				return [project.id, null] as const;
			}),
		).then((entries) => {
			if (cancelled) return;
			setCoverByProject(Object.fromEntries(entries));
		});
		return () => {
			cancelled = true;
		};
	}, [projects, nativeMatOSChat]);

	useEffect(() => {
		if (!menuOpenId) return;
		const onDocClick = (e: MouseEvent) => {
			const el = menuContainerRef.current;
			if (el && el.contains(e.target as Node)) return;
			setMenuOpenId(null);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuOpenId(null);
		};
		window.addEventListener("mousedown", onDocClick);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDocClick);
			window.removeEventListener("keydown", onKey);
		};
	}, [menuOpenId]);

	useEffect(() => {
		setSelected((curr) => {
			const valid = new Set(projects.map((p) => p.id));
			let changed = false;
			const next = new Set<string>();
			curr.forEach((id) => {
				if (valid.has(id)) next.add(id);
				else changed = true;
			});
			return changed ? next : curr;
		});
	}, [projects]);

	useEffect(() => {
		try {
			window.localStorage.setItem(DESIGNS_VIEW_STORAGE_KEY, view);
		} catch {}
	}, [view]);

	useEffect(() => {
		if (view === "kanban" && selectMode) exitSelectMode();
	}, [selectMode, view]);

	const refreshProjectsList = useCallback(
		async (source: "manual" | "auto") => {
			if (!onRefresh || projectsRefreshInFlightRef.current) return;
			projectsRefreshInFlightRef.current = true;
			setProjectsRefreshing(true);
			if (source === "manual") {
							}
			try {
				await onRefresh();
			} catch {
				if (source === "manual") {
					setDesignsToast({
						id: (toastIdRef.current += 1),
						message: t("designs.statusRefreshFailed"),
						role: "alert",
						tone: "error",
					});
				}
			} finally {
				projectsRefreshInFlightRef.current = false;
				setProjectsRefreshing(false);
			}
		},
		[onRefresh, t],
	);

	const refreshProjectsListRef = useRef(refreshProjectsList);
	useEffect(() => {
		refreshProjectsListRef.current = refreshProjectsList;
	}, [refreshProjectsList]);

	const hasProjectsRefresh = Boolean(onRefresh);
	useEffect(() => {
		if (!isActive || !hasProjectsRefresh) return;

		const refreshIfVisible = () => {
			if (document.visibilityState !== "visible") return;
			void refreshProjectsListRef.current("auto");
		};

		refreshIfVisible();
		const interval = window.setInterval(refreshIfVisible, PROJECTS_AUTO_REFRESH_MS);
		window.addEventListener("focus", refreshIfVisible);
		document.addEventListener("visibilitychange", refreshIfVisible);
		return () => {
			window.clearInterval(interval);
			window.removeEventListener("focus", refreshIfVisible);
			document.removeEventListener("visibilitychange", refreshIfVisible);
		};
	}, [hasProjectsRefresh, isActive]);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		let list: DesignListItem[] = projects.map((project) => ({
			type: "project",
			project,
			updatedAt: project.updatedAt,
			createdAt: project.createdAt,
		}));

		if (sub === "recent") {
			list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
		}

		if (sub === "yours") {
			list = list.sort((a, b) => b.createdAt - a.createdAt);
		}

		if (!q) return list;
		return list.filter((item) => {
			if (item.project.name.toLowerCase().includes(q)) return true;
			return nativeMatOSChat && [item.project.metadata?.goal, item.project.overview?.latestConversationTitle, visibleProjectDirectory(item.project)]
				.some(value => value?.toLowerCase().includes(q));
		});
	}, [projects, filter, sub, nativeMatOSChat]);

	const filteredProjects = useMemo(
		() =>
			filtered.filter(
				(item): item is Extract<DesignListItem, { type: "project" }> =>
					item.type === "project",
			),
		[filtered],
	);

	const skillName = (id: string | null) =>
		skills.find((s) => s.id === id)?.name ?? "";
	const toggleSelected = (id: string) => {
		setSelected((curr) => {
			const next = new Set(curr);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const exitSelectMode = () => {
		setSelectMode(false);
		setSelected(new Set());
	};
	const handleRenameProject = (project: Project) => {
		setRenameTarget({ id: project.id, original: project.name });
		setRenameInput(project.name);
	};
	const commitRename = () => {
		if (!renameTarget) return;
		const trimmed = renameInput.trim();
		if (trimmed && trimmed !== renameTarget.original) {
			onRename?.(renameTarget.id, trimmed);
		}
		setRenameTarget(null);
		setRenameInput("");
	};
	const cancelRename = () => {
		setRenameTarget(null);
		setRenameInput("");
	};
	const handleDeleteProject = (project: Project) => {
		setConfirmTarget({
			title: t("designs.deleteTitle"),
			message: t("designs.deleteConfirm", { name: project.name }),
			confirmLabel: t("designs.menuDelete"),
			onConfirm: () => onDelete(project.id),
		});
	};
	const handleDuplicateProject = (project: Project) => {
		if (!onDuplicate) return;
		void Promise.resolve(onDuplicate(project.id)).catch((err) => {
			setDesignsToast({
				id: (toastIdRef.current += 1),
				message: err instanceof Error ? err.message : String(err),
				role: "alert",
				tone: "error",
			});
		});
	};
	const handleBatchDelete = () => {
		const ids = Array.from(selected);
		if (ids.length === 0) return;
		setConfirmTarget({
			title: t("designs.deleteTitle"),
			message: t("designs.deleteSelectedConfirm", { n: ids.length }),
			confirmLabel: t("designs.deleteSelected"),
			onConfirm: async () => {
				const results = await Promise.all(
					ids.map(async (id) => {
						try {
							const result = await onDelete(id);
							return result !== false;
						} catch {
							return false;
						}
					}),
				);
				const deleted = results.filter(Boolean).length;
				const failed = results.length - deleted;
				exitSelectMode();
				const message =
					failed > 0
						? t("designs.deleteSelectedPartial", { deleted, failed })
						: t("designs.deleteSelectedSuccess", { n: deleted });
				setDesignsToast({
					id: (toastIdRef.current += 1),
					message,
					tone: "success",
				});
			},
		});
	};
	return (
		<div
			className={`tab-panel${view === "kanban" ? " design-kanban-view" : ""}`}
		>
			<div className="tab-panel-toolbar designs-toolbar">
				<div className="toolbar-left">
					<div
						className="subtab-pill"
						role="group"
						aria-label={t("designs.filterAria")}
					>
						<button
							aria-pressed={sub === "recent"}
							className={sub === "recent" ? "active" : ""}
							onClick={() => {
																setSub("recent");
							}}
						>
							{t("designs.subRecent")}
						</button>
						<button
							aria-pressed={sub === "yours"}
							className={sub === "yours" ? "active" : ""}
							onClick={() => {
																setSub("yours");
							}}
						>
							{t(nativeMatOSChat ? "projectCard.mine" : "designs.subYours")}
						</button>

					</div>
				</div>
				<div className="toolbar-right">
					{onNewProject && projects.length > 0 ? (
						<button
							type="button"
							className="designs-new-project-button"
							data-testid="designs-new-project"
							onClick={() => {
																onNewProject();
							}}
						>
							<Icon name="plus" size={13} />
							<span>{t("entry.navNewProject")}</span>
						</button>
					) : null}

					<div className="toolbar-search">
						<span className="search-icon" aria-hidden>
							<Icon name="search" size={13} />
						</span>
						<input
							placeholder={t("designs.searchPlaceholder")}
							aria-label={t("designs.searchPlaceholder")}
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							onFocus={() => {
								// P0 ui_click area=list_controls element=search_input.
								// Tracked on focus rather than every keystroke so each
								// engagement counts once.
															}}
						/>
					</div>
					{onRefresh ? (
						<button
							type="button"
							className="designs-refresh-button"
							onClick={() => void refreshProjectsList("manual")}
							disabled={projectsRefreshing}
							title={
								projectsRefreshing
									? t("designs.statusRefreshing")
									: t("designFiles.refresh")
							}
							aria-label={
								projectsRefreshing
									? t("designs.statusRefreshing")
									: t("designFiles.refresh")
							}
						>
							<Icon
								name={projectsRefreshing ? "spinner" : "refresh"}
								size={13}
								className={projectsRefreshing ? "icon-spin" : undefined}
							/>
							<span>
								{projectsRefreshing
									? t("designs.statusRefreshing")
									: t("designFiles.refresh")}
							</span>
						</button>
					) : null}
					{view === "grid" && selectMode ? (
						<div className="designs-select-bar" role="group">
							<span className="designs-select-count">
								{t("designs.selectedCount", { n: selected.size })}
							</span>
							<button
								type="button"
								className="designs-select-delete"
								disabled={selected.size === 0}
								onClick={handleBatchDelete}
							>
								{t("designs.deleteSelected")}
							</button>
							<button
								type="button"
								className="designs-select-cancel"
								onClick={exitSelectMode}
							>
								{t("designs.cancelSelect")}
							</button>
						</div>
					) : view === "grid" ? (
						<button
							type="button"
							className="designs-select-toggle"
							onClick={() => {
																setSelectMode(true);
							}}
						>
							<Icon name="check" size={13} />
							<span>{t("designs.selectMode")}</span>
						</button>
					) : null}
					<div
						className="subtab-pill"
						role="group"
						aria-label={t("designs.viewToggleAria")}
					>
						<button
							aria-pressed={view === "grid"}
							className={view === "grid" ? "active" : ""}
							onClick={() => {
																setView("grid");
							}}
							title={t("designs.viewGrid")}
							data-testid="designs-view-grid"
						>
							<Icon name="grid" size={14} />
						</button>
						<button
							aria-pressed={view === "kanban"}
							className={view === "kanban" ? "active" : ""}
							onClick={() => {
								// Kanban view substitutes for the contract's
								// list_view element.
																setView("kanban");
							}}
							title={t("designs.viewKanban")}
							data-testid="designs-view-kanban"
						>
							<Icon name="kanban" size={14} />
						</button>
					</div>
				</div>
			</div>
			{filtered.length === 0 ? (
				<div className="tab-empty">
					{projects.length === 0 ? (
						<div className="designs-empty-state">
							<h2 className="designs-empty-title">
								{t("designs.emptyNoProjects")}
							</h2>
							{onNewProject ? (
								<button
									type="button"
									className="primary designs-empty-cta"
									data-testid="designs-empty-new-project"
									onClick={() => {
																				onNewProject();
									}}
								>
									<span>{t("entry.navNewProject")}</span>
								</button>
							) : null}
						</div>
					) : (
						t("designs.emptyNoMatch")
					)}
				</div>
			) : view === "grid" ? (
				<div className="design-grid">
					{filtered.map((item) => {
						const p = item.project;
						const skill = skillName(p.skillId);
						const status = p.status?.value ?? "not_started";
						const preview = projectCover(p, coverByProject[p.id] ?? null);
						const cover = preview.src && failedCovers[p.id] === preview.src
							? { ...preview, kind: "fallback" as const, src: undefined } : preview;
						const isSelected = selected.has(p.id);
						return (
							<div
								key={p.id}
								className={`design-card${nativeMatOSChat ? ` ${projectCardStyles.gridCard}` : ""}${isSelected ? " is-selected" : ""}${selectMode ? " select-mode" : ""}`}
								data-testid={nativeMatOSChat ? "matos-project-card" : undefined}
								data-project-id={p.id}
								aria-label={p.name}
								data-project-boundary={isSharedWithMeProject(p) ? "shared-with-me" : "mine"}
								style={cover.vars}
								role="button"
								tabIndex={0}
								onClick={() => {
									if (selectMode) {
										toggleSelected(p.id);
									} else {
										// P0 ui_click area=list element=project_card.
																				onOpen(p.id);
									}
								}}
								onKeyDown={(e) => {
									if (e.target !== e.currentTarget) return;
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										if (selectMode) toggleSelected(p.id);
										else onOpen(p.id);
									}
								}}
							>
								{nativeMatOSChat && isSharedWithMeProject(p) ? <div className={projectCardStyles.shared}><SharedWithMeProjectTag /></div> : null}
								{selectMode ? (
									<span
										className={`design-card-checkbox${isSelected ? " checked" : ""}`}
										aria-hidden
									>
										{isSelected ? <Icon name="check" size={12} /> : null}
									</span>
								) : (
									<div
										className="design-card-menu-anchor"
										ref={menuOpenId === p.id ? menuContainerRef : undefined}
									>
										<button
											type="button"
											className="design-card-more"
											aria-label={t("designs.menuMore")}
											aria-haspopup="menu"
											aria-expanded={menuOpenId === p.id}
											onClick={(e) => {
												e.stopPropagation();
												setMenuOpenId((cur) => {
													const nextId = cur === p.id ? null : p.id;
													if (nextId === p.id) {
																											}
													return nextId;
												});
											}}
										>
											<Icon name="more-horizontal" size={14} />
									</button>
									{menuOpenId === p.id ? (
										<div
											className="design-card-menu"
											role="menu"
											onClick={(e) => e.stopPropagation()}
										>
											<button
												type="button"
												role="menuitem"
												onClick={() => {
																										setMenuOpenId(null);
													handleRenameProject(p);
												}}
											>
												<Icon name="pencil" size={12} />
												<span>{t("designs.menuRename")}</span>
											</button>
											{onDuplicate ? (
												<button
													type="button"
													role="menuitem"
													onClick={() => {
																												setMenuOpenId(null);
														handleDuplicateProject(p);
													}}
												>
													<Icon name="copy" size={12} />
													<span>{t("designs.menuDuplicate")}</span>
												</button>
											) : null}
											<button
												type="button"
												role="menuitem"
												className="danger"
												onClick={() => {
																										setMenuOpenId(null);
													handleDeleteProject(p);
												}}
											>
												<Icon name="close" size={12} />
												<span>{t("designs.menuDelete")}</span>
											</button>
										</div>
									) : null}
								</div>
								)}
								{nativeMatOSChat ? <ProjectCardContents project={p} /> : <><div
									className={`design-card-thumb project-thumb project-thumb-${cover.kind}`}
									style={cover.style}
									aria-hidden
								>
									{(cover.kind === "image" || cover.kind === "logo") && cover.src ? (
										<img className="thumb-media" src={cover.src} alt="" loading="lazy"
											onError={() => setFailedCovers(current => ({ ...current, [p.id]: cover.src! }))} />
									) : cover.kind === "video" && cover.src ? (
										<video className="thumb-media" src={cover.src} muted preload="metadata" playsInline />
									) : cover.kind === "html" && cover.src ? (
										<iframe
											className="thumb-iframe"
											src={cover.src}
											title=""
											loading="lazy"
											sandbox="allow-scripts"
											tabIndex={-1}
										/>
									) : (
										// MatOS projects rarely carry a preview file, so the
										// fallback face is the primary card visual: an
										// asset-type icon tile with a monogram corner badge.
										// Named "face" (not "fallback") because the thumb div
										// itself already carries project-thumb-fallback as its
										// kind class; sharing that name once let face styles
										// leak onto the thumb and crop the card's meta block.
										<span className="project-thumb-face">
											<span
												className={`project-thumb-icon ${matosAssetThumbIcon(p.metadata?.matosAssetType)}`}
											/>
											<span className="project-thumb-glyph project-thumb-glyph-chip">
												{cover.initial}
											</span>
										</span>
									)}
								</div>
								<div className="design-card-meta-block">
									<div className="design-card-tag-row">
										{p.metadata?.matosAssetType ? (
											<MatOSAssetTag type={p.metadata.matosAssetType} />
										) : (
											<ProjectTag category={projectCategory(p)} />
										)}
										{isSharedWithMeProject(p) ? <SharedWithMeProjectTag /> : null}
									</div>
									<div className="design-card-name" title={p.name}>
										{p.name}
									</div>
									<div className="design-card-meta">
										<span className="design-card-meta-main">
											<span>{t("designs.cardFreeform")}</span>
											{skill ? ` · ${skill}` : ""}
											{" · "}
											<span
												className={`design-card-status design-card-status-${status}`}
											>
												{statusLabel(status, t)}
											</span>
										</span>
										{sub === "recent" || sub === "yours" ? (
											<span className="design-card-meta-time">
												{relativeTime(p.updatedAt, t)}
											</span>
										) : null}
									</div>
								</div>
								</>}
							</div>
						);
					})}
				</div>
			) : (
				<div className="design-kanban-board">
					{STATUS_ORDER.map((status) => {
						const colProjects = filteredProjects.filter(
							(item) =>
								normalizeStatus(item.project.status?.value ?? "not_started") ===
								status,
						);
						return (
							<div key={status} className="design-kanban-col">
								<div className="design-kanban-header">
									<span>{nativeMatOSChat ? `${t("projectCard.latestTask")} · ` : ""}{statusLabel(status, t)}</span>
									<span className="design-kanban-count">
										{colProjects.length}
									</span>
								</div>
								<div className="design-kanban-list">
									{colProjects.length === 0 ? (
										<div className="design-kanban-empty">
											{t("designs.kanbanEmptyColumn")}
										</div>
									) : (
										colProjects.map(({ project: p }) => {
											const skill = skillName(p.skillId);
																					return (
												<div
													key={p.id}
													className={`design-kanban-card status-${status}${nativeMatOSChat ? ` ${projectCardStyles.kanbanCard}` : ""}`}
													data-testid={nativeMatOSChat ? "matos-project-card" : undefined}
													data-project-id={p.id}
													aria-label={p.name}
													data-project-boundary={isSharedWithMeProject(p) ? "shared-with-me" : "mine"}
													role="button"
													tabIndex={0}
													onClick={() => onOpen(p.id)}
													onKeyDown={(e) => {
														if (e.target !== e.currentTarget) return;
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															onOpen(p.id);
														}
													}}
												>
													<button
														className="design-card-close"
														title={t("designs.deleteTitle")}
														aria-label={t("designs.deleteAria", {
															name: p.name,
														})}
														onClick={(e) => {
															e.stopPropagation();
															handleDeleteProject(p);
														}}
													>
														<Icon name="close" size={12} />
													</button>
													<div
														className="design-kanban-card-name"
														title={p.name}
													>
														{p.name}
													</div>
													{isSharedWithMeProject(p) ? (
														<div className="design-card-tag-row">
																														{isSharedWithMeProject(p) ? <SharedWithMeProjectTag /> : null}
														</div>
													) : null}
													{!nativeMatOSChat ? <div className="design-kanban-card-meta">
														<span>{t("designs.cardFreeform")}</span>
														{skill ? ` · ${skill}` : ""}
														{sub === "recent" || sub === "yours"
															? ` · ${relativeTime(p.updatedAt, t)}`
															: ""}
													</div> : null}
												</div>
											);
										})
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
			{renameTarget ? (
				<Dialog
					as="form"
					className="modal-rename"
					onClose={cancelRename}
					closeOnEscape
					ariaLabelledBy={renameTitleId}
					onSubmit={(e) => {
						e.preventDefault();
						commitRename();
					}}
				>
					<DialogTitle id={renameTitleId}>{t("designs.renameTitle")}</DialogTitle>
					<label>
						{t("designs.renamePrompt", { name: renameTarget.original })}
						<input
							type="text"
							value={renameInput}
							autoFocus
							onChange={(e) => setRenameInput(e.target.value)}
						/>
					</label>
					<DialogFooter className="row">
						<button type="button" onClick={cancelRename}>
							{t("designs.renameCancel")}
						</button>
						<button
							type="submit"
							className="primary"
							disabled={
								!renameInput.trim() ||
								renameInput.trim() === renameTarget.original
							}
						>
							{t("designs.renameSave")}
						</button>
					</DialogFooter>
				</Dialog>
			) : null}
			{confirmTarget ? (
				<Dialog
					className="modal-confirm"
					role="alertdialog"
					onClose={() => setConfirmTarget(null)}
					ariaLabelledBy={confirmTitleId}
				>
					<DialogTitle id={confirmTitleId}>{confirmTarget.title}</DialogTitle>
					<DialogDescription className="modal-confirm-message">{confirmTarget.message}</DialogDescription>
					<DialogFooter className="row">
						<button type="button" onClick={() => setConfirmTarget(null)}>
							{t("designs.renameCancel")}
						</button>
						<button
							type="button"
							className="primary danger"
							autoFocus
							onClick={() => {
								const run = confirmTarget.onConfirm;
								setConfirmTarget(null);
								run();
							}}
						>
							{confirmTarget.confirmLabel}
						</button>
					</DialogFooter>
				</Dialog>
			) : null}

			<AnimatePresence>
				{designsToast ? (
					<Toast
						key={designsToast.id}
						message={designsToast.message}
						role={designsToast.role}
						tone={designsToast.tone}
						onDismiss={() => setDesignsToast(null)}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}

function normalizeStatus(
	status: ProjectDisplayStatus,
): Exclude<ProjectDisplayStatus, "queued"> {
	return status === "queued" ? "running" : status;
}

function statusLabel(
	status: ProjectDisplayStatus,
	t: ReturnType<typeof useT>,
): string {
	return t(STATUS_LABEL_KEYS[status]);
}

function relativeTime(ts: number, t: ReturnType<typeof useT>): string {
	const diff = Date.now() - ts;
	const min = 60_000;
	const hr = 60 * min;
	const day = 24 * hr;
	if (diff < min) return t("common.justNow");
	if (diff < hr) return t("common.minutesAgo", { n: Math.floor(diff / min) });
	if (diff < day) return t("common.hoursAgo", { n: Math.floor(diff / hr) });
	if (diff < 7 * day) return t("common.daysAgo", { n: Math.floor(diff / day) });
	return new Date(ts).toLocaleDateString();
}

/** Shared projects are imported into the dedicated read/write collaboration
 * location by the daemon. Keep this as the UI's single ownership test so the
 * project grid, kanban, home strip, and filters cannot drift apart. */
export function isSharedWithMeProject(project: Pick<Project, "metadata">): boolean {
	return project.metadata?.projectLocationId === "shared-workspaces";
}

export function sharedWithMeProjectLabel(locale: string): string {
	if (locale.toLowerCase() === "zh-tw") return "匯入專案";
	return locale.toLowerCase().startsWith("zh") ? "导入项目" : "Imported project";
}

export function SharedWithMeProjectTag() {
	const { locale } = useI18n();
	return (
		<span className="design-card-tag tag-shared-with-me" data-testid="project-shared-with-me-tag">
			{sharedWithMeProjectLabel(locale)}
		</span>
	);
}


// One tone per MatOS asset family so a card's icon, type badge, and wash
// share a single color system (icon color / badge / gradient used to come
// from three unrelated sources). Plain projects keep the per-project hash
// hue for grid variety. `sat` scales every saturation stop of the family
// (default 1): prompt sits next to knowledge on the wheel, so it is grayed
// down instead of hue-shifted to stay distinguishable; orange needs extra
// chroma or it reads brown at this palette's 42% lightness.
const MATOS_ASSET_TONES: Record<string, { hue: number; sat?: number }> = {
	workflow: { hue: 152 }, // green
	knowledge: { hue: 215 }, // blue
	skill: { hue: 262 }, // violet
	tool: { hue: 28, sat: 1.2 }, // orange
	role: { hue: 336 }, // rose
	data: { hue: 187 }, // teal
	prompt: { hue: 222, sat: 0.45 }, // gray-blue
};

function projectCover(
	project: Project,
	override: { kind: "html" | "image" | "video" | "logo"; name: string } | null,
): {
	kind: "image" | "video" | "html" | "logo" | "fallback";
	src?: string;
	style: CSSProperties;
	/** Custom properties for the card root: badge/chip/icon share the hue. */
	vars: CSSProperties;
	initial: string;
} {
	let h = 0;
	for (let i = 0; i < project.id.length; i++) {
		h = (h * 31 + project.id.charCodeAt(i)) >>> 0;
	}
	const meta = project.metadata;
	const tone = meta?.matosAssetType
		? MATOS_ASSET_TONES[meta.matosAssetType]
		: undefined;
	const hue = tone?.hue ?? h % 360;
	const hue2 = (hue + 26) % 360;
	const sat = (base: number) => Math.min(100, Math.round(base * (tone?.sat ?? 1)));
	// Muted duotone wash: the old high-saturation gradient dominated grids of
	// preview-less MatOS projects. Keep the hue for recognition, drop the
	// loudness; a faint dot grid adds texture without noise.
	const style: CSSProperties = {
		background: `radial-gradient(circle at 1px 1px, hsl(${hue} ${sat(32)}% 52% / 0.14) 1px, transparent 1.5px) 0 0 / 14px 14px, radial-gradient(circle at 28% 20%, hsl(${hue} ${sat(60)}% 96% / 0.9), transparent 58%), linear-gradient(155deg, hsl(${hue} ${sat(46)}% 94%), hsl(${hue2} ${sat(44)}% 89%))`,
		color: `hsl(${hue} ${sat(46)}% 42%)`,
	};
	const vars = {
		"--card-accent": `hsl(${hue} ${sat(46)}% 42%)`,
		"--card-accent-strong": `hsl(${hue} ${sat(50)}% 32%)`,
	} as CSSProperties;
	const trimmed = project.name.trim();
	const initial = (trimmed ? Array.from(trimmed)[0]! : "?").toUpperCase();
		if (override) {
		return {
			kind: override.kind,
			src: projectFileUrl(project.id, override.name),
			style,
			vars,
			initial,
		};
	}
	const entry = meta?.entryFile;
	if (entry) {
		const src = projectFileUrl(project.id, entry);
		if (meta?.kind === "image") return { kind: "image", src, style, vars, initial };
		if (meta?.kind === "video") return { kind: "video", src, style, vars, initial };
		if (/\.html?$/i.test(entry)) return { kind: "html", src, style, vars, initial };
	}
	return { kind: "fallback", style, vars, initial };
}

type ProjectCategory = "prototype" | "slide" | "media";

function projectCategory(project: Project): ProjectCategory {
	const meta = project.metadata;
	if (meta?.kind === "deck") return "slide";
	if (meta?.kind === "image" || meta?.kind === "video" || meta?.kind === "audio") {
		return "media";
	}
	return "prototype";
}

// MatOS asset-editing drafts (spawned from the "+" create menu) show their
// asset family instead of the generic design category, so a knowledge draft
// reads as Knowledge, not Prototype.
function MatOSAssetTag({ type }: { type: string }) {
	const t = useT();
	const label = t(`createMenu.${type}` as never) || type;
	return <span className="design-card-tag tag-matos-asset">{label}</span>;
}

// Fallback card-face icon per MatOS asset type (remixicon classes verified
// against the bundled remixicon.css). Unknown/plain projects get a folder.
function matosAssetThumbIcon(type?: string): string {
	switch (type) {
		case "workflow":
			return "ri-route-line";
		case "knowledge":
			return "ri-book-open-line";
		case "skill":
			return "ri-magic-line";
		case "tool":
			return "ri-tools-line";
		case "role":
			return "ri-user-star-line";
		case "data":
			return "ri-database-2-line";
		case "prompt":
			return "ri-chat-quote-line";
		default:
			return "ri-folder-3-line";
	}
}

function ProjectTag({ category }: { category: ProjectCategory }) {
	const t = useT();
	const label =
		category === "slide"
			? t("designs.tagSlide")
			: category === "media"
				? t("designs.tagMedia")
				: t("designs.tagPrototype");
	return (
		<span className={`design-card-tag tag-${category}`}>{label}</span>
	);
}
