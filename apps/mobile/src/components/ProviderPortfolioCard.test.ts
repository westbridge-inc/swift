import { beforeEach, describe, expect, it, vi } from 'vitest';

// [IMAGES-E2E · REVIEW-F S4-3 on #1918] The provider's portfolio card: kept photos are shown,
// an outside address is named (never loaded), removing asks first and says what happens, a
// full portfolio offers no upload, and a refusal shows the server's words. The component is
// called as a function (no RN renderer), as in WithdrawStaffInvites.test.ts; useState is a
// small store so a second call sees the first call's state.

const h = vi.hoisted(() => ({
  state: [] as unknown[],
  at: 0,
  mAt: 0,
  mutations: [] as Array<{ opts: any; mutate: ReturnType<typeof vi.fn>; isPending: boolean }>,
}));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = h.at++;
    if (!(slot in h.state)) h.state[slot] = initial;
    return [h.state[slot], (next: unknown) => { h.state[slot] = next; }];
  },
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: {}, scrim: 'scrim', white: 'white' }, radius: {}, space: {} }));
vi.mock('../kit', () => ({
  Card: 'Card', LinkText: 'LinkText', PillButton: 'PillButton', PopupCard: 'PopupCard', PopupTitle: 'PopupTitle', T: 'T',
}));
vi.mock('../services/api', () => ({ servicesApi: { uploadPortfolioPhoto: vi.fn(), removePortfolioPhoto: vi.fn() } }));
vi.mock('../lib/images', () => ({ storePhotoUrl: (key: string, w: number) => `door:${key}?w=${w}` }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // Per draw the card asks for two mutations: upload (slot 0), then remove (slot 1).
  useMutation: (opts: unknown) => {
    const slot = h.mAt++;
    h.mutations[slot] ??= { opts, mutate: vi.fn(), isPending: false };
    h.mutations[slot]!.opts = opts;
    return h.mutations[slot];
  },
}));

import { ProviderPortfolioCard } from './ProviderPortfolioCard';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) all(n, match, out); return out; }
  if (match(node)) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) all(child, match, out);
  return out;
}
const textOf = (n: any) => [n.props.children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree: any) => all(tree, (n) => n.type === 'T' || n.type === 'PopupTitle').map(textOf);
const ofType = (tree: any, type: string) => all(tree, (n) => n.type === type);
const pill = (tree: any, label: string) => ofType(tree, 'PillButton').find((b) => b.props.label === label);

const KEPT = 'portfolio/prov_1/abcdefghijklmnop.jpg';
const OUTSIDE = 'https://elsewhere.example/work.jpg';
let photos: string[] = [];
const draw = () => { h.at = 0; h.mAt = 0; return ProviderPortfolioCard({ photos }); };
const upload = () => h.mutations[0]!;
const remove = () => h.mutations[1]!;

beforeEach(() => {
  h.state = [];
  h.mutations = [];
  photos = [KEPT, OUTSIDE];
});

describe('the provider portfolio card', () => {
  it('shows a kept photo through the photo door and names an outside address without loading it', () => {
    const tree = draw();
    expect(ofType(tree, 'Image').map((i) => i.props.source.uri)).toEqual([`door:${KEPT}?w=320`]);
    expect(texts(tree)).toContain('Not shown. Upload it again.');
  });

  it('removing asks first: "Keep it" keeps the photo, "Remove photo" removes exactly that one', () => {
    let tree = draw();
    expect(ofType(tree, 'PopupCard')[0].props.visible).toBe(false);
    const [first] = ofType(tree, 'Pressable');
    expect(first.props.accessibilityLabel).toBe('Remove this photo');
    first.props.onPress();
    tree = draw();
    expect(ofType(tree, 'PopupCard')[0].props.visible).toBe(true);
    expect(texts(tree)).toContain('Remove this photo?');
    expect(texts(tree)).toContain('It is deleted from Swift and customers stop seeing it.');
    pill(tree, 'Keep it').props.onPress();
    tree = draw();
    expect(ofType(tree, 'PopupCard')[0].props.visible).toBe(false);
    expect(remove().mutate).not.toHaveBeenCalled();

    ofType(tree, 'Pressable')[0].props.onPress();
    tree = draw();
    pill(tree, 'Remove photo').props.onPress();
    expect(remove().mutate).toHaveBeenCalledWith(KEPT);
    expect(ofType(draw(), 'PopupCard')[0].props.visible).toBe(false);
  });

  it('an outside address is "taken off your list": there is nothing of Swift\'s to delete', () => {
    ofType(draw(), 'Pressable')[1].props.onPress();
    const tree = draw();
    expect(texts(tree)).toContain('It is taken off your list.');
    expect(texts(tree)).not.toContain('It is deleted from Swift and customers stop seeing it.');
    pill(tree, 'Remove photo').props.onPress();
    expect(remove().mutate).toHaveBeenCalledWith(OUTSIDE);
  });

  it('a full portfolio offers no upload; one with room does', () => {
    expect(ofType(draw(), 'LinkText').map((l) => l.props.label)).toEqual(['Add a photo']);
    photos = Array.from({ length: 12 }, (_, i) => `portfolio/prov_1/${String(i).padStart(16, 'a')}.jpg`);
    const tree = draw();
    expect(ofType(tree, 'LinkText')).toEqual([]);
    expect(texts(tree)).toContain('Your portfolio is full. Remove a photo to add another.');
  });

  it('a refused upload or removal shows the server\'s words, or a plain fallback', () => {
    draw();
    upload().opts.onError({ response: { data: { error: { message: 'A portfolio holds 12 photos. Remove one to add another.' } } } });
    expect(texts(draw())).toContain('A portfolio holds 12 photos. Remove one to add another.');
    upload().opts.onError(new Error('offline'));
    expect(texts(draw())).toContain("That photo didn't upload. Check your connection and try again.");
    remove().opts.onError({});
    expect(texts(draw())).toContain("That photo couldn't be removed. Try again.");
  });
});
