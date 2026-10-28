import { ICONS, type IconName } from '@omniclip/ui';

/** A line icon from the shared OmniClip set. The markup is a constant from @omniclip/ui, never user data. */
export function Icon({ name, size }: { name: IconName; size?: 'sm' | 'lg' }) {
  return <svg class={size ? `i ${size}` : 'i'} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}
