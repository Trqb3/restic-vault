export interface ResticSnapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  username: string;
  tags: string[] | null;
  paths: string[];
  tree: string;
  parent?: string;
  summary?: {
    files_new: number;
    files_changed: number;
    files_unmodified: number;
    dirs_new: number;
    dirs_changed: number;
    dirs_unmodified: number;
    data_blobs: number;
    tree_blobs: number;
    data_added: number;
    total_files_processed: number;
    total_bytes_processed: number;
  };
}

export interface ResticStatsResult {
  total_size: number;
  total_file_count: number | null;
  total_blob_count?: number | null;
  compression_ratio?: number | null;
}

export interface ResticLsNode {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  path: string;
  size?: number;
  mtime?: string;
  struct_type?: string;
}

export interface ResticDiffItem {
  path?: string;
  modifier?: string;
  message_type?: string;
  files?: {
    new: number;
    removed: number;
    changed: number;
    unmodified: number;
  };
  dirs?: Record<string, number>;
  data_blobs?: number;
  tree_blobs?: number;
  data_added?: number;
  data_added_packed?: number;
  total_files_processed?: number;
  total_bytes_processed?: number;
}
