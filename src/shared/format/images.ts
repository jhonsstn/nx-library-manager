/** Ports `ui._higher_res_image_url` so cached IGDB art requests the largest variant. */
export function higherResImageUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (!url.includes('images.igdb.com')) return url;
  if (url.includes('t_screenshot_') || url.includes('t_720p')) {
    return url
      .replace('t_screenshot_med', 't_1080p')
      .replace('t_screenshot_big', 't_1080p')
      .replace('t_screenshot_huge', 't_1080p')
      .replace('t_720p', 't_1080p');
  }
  if (url.includes('t_cover_big_2x')) return url;
  if (url.includes('t_cover_big')) return url.replace('t_cover_big', 't_cover_big_2x');
  if (url.includes('t_thumb')) return url.replace('t_thumb', 't_cover_big_2x');
  return url;
}

/** Ports `ui._youtube_player_url` for the trailer dialog. */
export function youtubePlayerUrl(url: string): string {
  if (url.includes('youtube.com/watch')) return url;
  if (url.includes('youtube.com/embed/')) {
    const videoId = url.split('/').pop()?.split('?')[0] ?? '';
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (url.includes('youtu.be/')) {
    const videoId = url.split('/').pop()?.split('?')[0] ?? '';
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return url;
}

/** Ports `ui._youtube_embed_url` for inline playback. */
export function youtubeEmbedUrl(url: string): string {
  if (url.includes('youtube.com/watch')) {
    const query = url.split('?')[1] ?? '';
    const videoId = query
      .split('&')
      .find((part) => part.startsWith('v='))
      ?.slice('v='.length);
    if (videoId) return `https://www.youtube.com/embed/${videoId}`;
  }
  if (url.includes('youtu.be/')) {
    const videoId = url.split('/').pop()?.split('?')[0] ?? '';
    if (videoId) return `https://www.youtube.com/embed/${videoId}`;
  }
  return url;
}
