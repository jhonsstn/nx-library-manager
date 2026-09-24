import { z } from 'zod';

const positiveInt = z.number().int().positive();
const idList = z.array(positiveInt).default([]);

export const ListGamesInputSchema = z.object({
  search: z.string().optional(),
  genre: z.string().nullish(),
  favoritesOnly: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  needsUpdate: z.boolean().optional(),
  readyToInstall: z.boolean().optional(),
  hiddenOnly: z.boolean().optional(),
  sort: z.enum(['title-asc', 'title-desc', 'added-desc']).optional(),
  limit: positiveInt.max(10_000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const ScanInputSchema = z.object({
  baseFolder: z.string().optional(),
  updatesFolder: z.string().optional(),
  recursive: z.boolean().optional(),
  threshold: z.number().min(0).max(1).optional(),
  resetLibrary: z.boolean().optional(),
});

export const ChooseDirectoryInputSchema = z.object({
  title: z.string().optional(),
  defaultPath: z.string().optional(),
  mtp: z.boolean().optional(),
});

export const InstallDestinationSchema = z.union([
  z.object({ type: z.literal('folder'), path: z.string().min(1) }),
  z.object({ type: z.literal('mtp'), storage: z.enum(['sd', 'nand']) }),
]);

export const CreateInstallInputSchema = z
  .object({
    gameId: positiveInt.nullish(),
    updateIds: idList,
    includeBaseFile: z.boolean().optional(),
    destination: InstallDestinationSchema,
    inventoryRevision: z.number().int().nonnegative().optional(),
    allowAlreadyInstalled: z.boolean().optional(),
    allowUnverified: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.gameId) || value.updateIds.length > 0, {
    message: 'An install request needs a base game or at least one update file.',
  });

export const PreviewInstallInputSchema = z.object({
  gameId: positiveInt,
  updateIds: idList,
  includeBaseFile: z.boolean().optional(),
  mode: z.enum(['suggested', 'selected']),
});

export const DeleteFileInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('game'), gameId: positiveInt }),
  z.object({ kind: z.literal('update'), updateId: positiveInt }),
]);

const UpdateCleanupFileSchema = z.object({
  filePath: z.string().min(1), fileName: z.string().min(1),
  fileSize: z.number().int().nonnegative(), modifiedTime: z.number().finite(),
  rawVersion: z.number().int().positive(),
});

export const UpdateCleanupPreviewSchema = z.object({
  latestLocalVersion: z.number().int().positive(),
  keepFiles: z.array(UpdateCleanupFileSchema).min(1),
  deleteFiles: z.array(UpdateCleanupFileSchema).min(1),
});

export const MoveFileInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('game'), gameId: positiveInt, destinationFolder: z.string().min(1) }),
  z.object({ kind: z.literal('update'), updateId: positiveInt, destinationFolder: z.string().min(1) }),
]);

export const AssignUpdatesInputSchema = z.object({
  gameId: positiveInt,
  updateIds: z.array(positiveInt).min(1),
});

export const UnmatchUpdatesInputSchema = z.array(positiveInt).min(1);

export const ListUpdatesInputSchema = z.object({
  unmatchedOnly: z.boolean().optional(),
});

export const BulkRefreshInputSchema = z.object({
  force: z.boolean().optional(),
  limit: positiveInt.optional(),
});

export const MetadataSearchInputSchema = z.object({
  gameId: positiveInt,
  query: z.string().optional(),
});

/** Candidates round-trip renderer → main, so they are validated on the way back. */
export const MetadataCandidateSchema = z.object({
  provider: z.string().min(1),
  providerId: z.string(),
  title: z.string().min(1),
  description: z.string(),
  releaseDate: z.string(),
  developer: z.string(),
  publisher: z.string(),
  genres: z.array(z.string()),
  coverImageUrl: z.string(),
  trailerUrl: z.string(),
  screenshots: z.array(z.string()),
  confidence: z.number(),
});

export const OpenExternalInputSchema = z.object({
  url: z.string().url(),
});

export const GameIdSchema = positiveInt;
