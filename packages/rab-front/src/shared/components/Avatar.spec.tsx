import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Avatar, { ImageWorkspaceContext } from './Avatar';
import { api } from '../api';
jest.mock('../api', () => ({ api: { get: jest.fn() } }));
beforeEach(() => {
  jest.clearAllMocks();
  URL.createObjectURL = jest.fn(() => 'blob:photo');
  URL.revokeObjectURL = jest.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: jest.fn().mockResolvedValue(undefined) });
});
test('waits for decode before revealing and releases private object URLs', async () => {
  let decode!: () => void;
  (HTMLImageElement.prototype.decode as jest.Mock).mockReturnValue(new Promise<void>(r => { decode = r; }));
  (api.get as jest.Mock).mockResolvedValue({data:new Blob(['image'])});
  const { container, unmount }=render(<Avatar imageKey="photo" label="Sam Smith"/>);
  expect(screen.getByRole('img',{name:'Loading Sam Smith'})).toBeInTheDocument();
  fireEvent.load(await screen.findByAltText('Sam Smith'));
  expect(container.querySelector('.progressive-avatar')).not.toHaveClass('is-loaded');
  await act(async()=>decode());
  expect(container.querySelector('.progressive-avatar')).toHaveClass('is-loaded');
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
});
test('failed downloads retain initials', async () => {
  (api.get as jest.Mock).mockRejectedValue(new Error('unavailable'));
  render(<Avatar imageKey="missing" label="Sam Smith"/>);
  expect(await screen.findByText('SS')).toBeInTheDocument();
});
test('decode failures show fallback rather than an invisible image', async () => {
  (HTMLImageElement.prototype.decode as jest.Mock).mockRejectedValue(new Error('invalid'));
  render(<Avatar previewUrl="blob:first" label="Sam Smith"/>);
  fireEvent.load(screen.getByAltText('Sam Smith'));
  expect(await screen.findByText('SS')).toBeInTheDocument();
});
test('changing photos drops the old image and ignores its pending decode', async () => {
  let decode!: () => void;
  (HTMLImageElement.prototype.decode as jest.Mock).mockReturnValue(new Promise<void>(r => { decode = r; }));
  const {rerender,container}=render(<Avatar previewUrl="blob:first" label="Sam Smith"/>);
  fireEvent.load(screen.getByAltText('Sam Smith'));
  rerender(<Avatar previewUrl="blob:second" label="Sam Smith"/>);
  await act(async()=>decode());
  expect(screen.getByAltText('Sam Smith')).toHaveAttribute('src','blob:second');
  expect(container.querySelector('.progressive-avatar')).not.toHaveClass('is-loaded');
});
test('ordinary rerenders do not refetch or restart loading', async () => {
  (api.get as jest.Mock).mockResolvedValue({data:new Blob(['image'])});
  const {rerender,container}=render(<Avatar imageKey="photo" label="Sam Smith"/>);
  fireEvent.load(await screen.findByAltText('Sam Smith'));
  await waitFor(()=>expect(container.querySelector('.progressive-avatar')).toHaveClass('is-loaded'));
  rerender(<Avatar imageKey="photo" label="Sam S"/>);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(container.querySelector('.progressive-avatar')).toHaveClass('is-loaded');
});
test('workspace switching cannot reuse a local preview from the previous workspace', () => {
  const {rerender}=render(<ImageWorkspaceContext.Provider value="one"><Avatar previewUrl="blob:private" label="Sam"/></ImageWorkspaceContext.Provider>);
  expect(screen.getByAltText('Sam')).toBeInTheDocument();
  rerender(<ImageWorkspaceContext.Provider value="two"><Avatar previewUrl="blob:private" label="Sam"/></ImageWorkspaceContext.Provider>);
  expect(screen.queryByAltText('Sam')).not.toBeInTheDocument();
});
test('unmount aborts request and late completion cannot create an object URL', async () => {
  let resolve!: (value: unknown) => void;
  (api.get as jest.Mock).mockReturnValue(new Promise(r=>{resolve=r;}));
  const {unmount}=render(<Avatar imageKey="photo" label="Sam"/>);
  const signal=(api.get as jest.Mock).mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async()=>resolve({data:new Blob(['image'])}));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('fast local loads skip the transition', async () => {
  const {container}=render(<Avatar previewUrl="blob:local" label="Sam"/>);
  fireEvent.load(screen.getByAltText('Sam'));
  await waitFor(()=>expect(container.querySelector('.progressive-avatar')).toHaveClass('is-instant'));
});
test('offscreen images wait for intersection before requesting bytes', async () => {
  let callback!: IntersectionObserverCallback;
  const original=global.IntersectionObserver;
  global.IntersectionObserver=jest.fn().mockImplementation(cb=>{callback=cb;return {observe:jest.fn(),disconnect:jest.fn()};});
  (api.get as jest.Mock).mockResolvedValue({data:new Blob(['image'])});
  try {
    render(<Avatar imageKey="lazy-photo" label="Sam"/>);
    expect(api.get).not.toHaveBeenCalled();
    await act(async()=>callback([{isIntersecting:true}] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(api.get).toHaveBeenCalledTimes(1);
  }finally{global.IntersectionObserver=original;}
});

test('logout removes the photo and releases its blob immediately', async () => {
  const { applyIdentityFromServer, markUnauthenticated } = await import('../lib/auth-session');
  applyIdentityFromServer({userId:'image-user',sessionId:'image-session'});
  (api.get as jest.Mock).mockResolvedValue({data:new Blob(['image'])});
  render(<Avatar imageKey="private-photo" label="Sam"/>);
  await screen.findByAltText('Sam');
  act(()=>markUnauthenticated());
  expect(screen.queryByAltText('Sam')).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
  await act(async()=>applyIdentityFromServer({userId:'next-user',sessionId:'next-session'}));
});
