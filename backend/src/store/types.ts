/**
 * 数据仓库接口：当前只有 JSON 文件实现，但接口保持中立，
 * 后续可平滑替换为 SQLite/Postgres 而不动路由层。
 */
import type { ListProjectsQuery, NetdiskSource, Paginated, Project, TagCount } from '../types.js';

/**
 * 可更新字段（PATCH 语义：未出现的字段保持不变，契约 §3.7）。
 * 网盘信息（url / 提取码 / 文件名 / 备注）任一被修改时，路由层会重算
 * provider / providerLabel 后整体替换 `source`。
 */
export interface ProjectUpdate {
  title?: string;
  description?: string;
  author?: string;
  tags?: string[];
  source?: NetdiskSource;
}

/** 计数增量（浏览/下载） */
export interface StatsDelta {
  views?: number;
  downloads?: number;
}

export interface ProjectStore {
  /** 加载持久化数据（启动时调用一次） */
  init(): Promise<void>;
  find(id: string): Promise<Project | null>;
  list(query: ListProjectsQuery): Promise<Paginated<Project>>;
  create(project: Project): Promise<Project>;
  update(id: string, patch: ProjectUpdate): Promise<Project | null>;
  remove(id: string): Promise<Project | null>;
  /** 计数自增：必须走同一条写队列，保证并发下不丢计数 */
  incrementStats(id: string, delta: StatsDelta): Promise<Project | null>;
  /** 标签聚合（count 降序、name 升序） */
  allTags(): Promise<TagCount[]>;
  /** 按 PNG 的 sha256 查找（去重用） */
  sha256Exists(sha256: string): Promise<Project | null>;
  count(): Promise<number>;
}
