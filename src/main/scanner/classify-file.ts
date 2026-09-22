import { isDlcGroupFilename, isUpdateOrDlcFilename } from './filename-parser';

/**
 * Port of `ui._update_file_group` and the classification the catalog stores for
 * scanned files (`switch_catalog/scanner.py` splits update candidates into the
 * base/update/DLC kinds through the same rules).
 */

export type UpdateFileGroup = 'Updates' | 'DLC';

export type GameFileKind = 'base' | 'update' | 'dlc';

export interface GameFileClassification {
  kind: GameFileKind;
  group: UpdateFileGroup;
}

/** `ui._update_file_group`: DLC names/title IDs go to `DLC`, every other update to `Updates`. */
export function updateFileGroup(fileName: string): UpdateFileGroup {
  return isDlcGroupFilename(fileName) ? 'DLC' : 'Updates';
}

/** The group plus the kind the scanner records for a file. */
export function classifyGameFile(fileName: string): GameFileClassification {
  const group = updateFileGroup(fileName);
  if (group === 'DLC') return { kind: 'dlc', group };
  return { kind: isUpdateOrDlcFilename(fileName) ? 'update' : 'base', group };
}
