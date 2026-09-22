export interface DeleteFileResultDto {
  id: number;
  kind: 'game' | 'update';
  deletedFromDisk: boolean;
  /** True when a `game` row delete also removed dependent catalog rows. */
  cascaded: boolean;
}
