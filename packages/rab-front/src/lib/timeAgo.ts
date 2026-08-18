export function timeAgo(input?: string | Date | null): string {
  if (!input) return '–';
  const seconds = (Date.now() - new Date(input).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'about 1 hour ago' : `about ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return days === 1 ? 'a day ago' : `${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return months === 1 ? 'a month ago' : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}
