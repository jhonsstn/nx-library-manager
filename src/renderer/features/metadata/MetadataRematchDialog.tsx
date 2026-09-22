import { useEffect, useState } from 'react';
import { SwitchCatalogError } from '@shared/errors/app-error';
import type { MetadataCandidateDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { Cover } from '@renderer/components/Cover';
import { ErrorText, Skeleton, Spinner } from '@renderer/components/Feedback';
import { Modal } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { useGame, useMetadataMutations } from '@renderer/query/hooks';

export interface MetadataRematchDialogProps {
  gameId: number;
  onClose: () => void;
}

/**
 * Manual metadata rematch (spec 13, Flow E). The first search runs with the
 * game's own title; picking a candidate locks the choice in the main process.
 */
export function MetadataRematchDialog({ gameId, onClose }: MetadataRematchDialogProps) {
  const game = useGame(gameId);
  const { search, apply } = useMetadataMutations();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [seeded, setSeeded] = useState(false);

  const gameTitle = game.data?.cleanedTitle || game.data?.displayTitle || '';

  useEffect(() => {
    if (seeded || !gameTitle) return;
    setSeeded(true);
    setQuery(gameTitle);
    search.mutate({ gameId, query: gameTitle });
  }, [gameTitle, seeded, gameId, search]);

  const runSearch = () => {
    const text = query.trim();
    if (!text) return;
    search.mutate({ gameId, query: text });
  };

  const applyCandidate = (candidate: MetadataCandidateDto) => {
    apply.mutate(
      { gameId, candidate },
      {
        onSuccess: () => {
          toast.success('Metadata updated', `${candidate.title} applied and locked.`);
          onClose();
        },
      },
    );
  };

  const authMissing =
    (search.error instanceof SwitchCatalogError && search.error.code === 'METADATA_AUTH_ERROR') ||
    (apply.error instanceof SwitchCatalogError && apply.error.code === 'METADATA_AUTH_ERROR');
  const candidates = search.data ?? [];

  return (
    <Modal
      title="Search Metadata"
      onClose={onClose}
      wide
      footer={<Button onClick={onClose}>Cancel</Button>}
    >
      <form
        className="row metadata-search"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <input
          className="input"
          aria-label="Metadata search title"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Game title…"
        />
        <Button type="submit" disabled={search.isPending}>
          Search
        </Button>
      </form>

      {game.isLoading ? <Skeleton width="45%" /> : null}
      {search.isPending ? <Spinner label="Searching IGDB…" /> : null}

      <ErrorText error={search.error} />
      <ErrorText error={apply.error} />
      {authMissing ? (
        <p className="install-warning">
          IGDB credentials are missing or rejected. Add the client ID and secret in Settings, then search again.
        </p>
      ) : null}

      {!search.isPending && !search.error && candidates.length === 0 ? (
        <p className="dim">No matches yet. Search with a different title.</p>
      ) : null}

      <ul className="list metadata-candidates" aria-label="Metadata candidates">
        {candidates.map((candidate) => (
          <li key={`${candidate.provider}:${candidate.providerId}`} className="list__item list__item--static">
            <button
              type="button"
              className="metadata-candidate"
              aria-label={`Use ${candidate.title}`}
              disabled={apply.isPending}
              onClick={() => applyCandidate(candidate)}
            >
              <Cover
                src={candidate.coverImageUrl}
                alt={candidate.title}
                className="metadata-candidate__cover"
              />
              <span className="metadata-candidate__body">
                <span className="metadata-candidate__title">{candidate.title}</span>
                <span className="dim">Released: {candidate.releaseDate || 'Unknown'}</span>
                <span className="badge" title="Match confidence">
                  Confidence {Math.round(candidate.confidence * 100)}%
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
