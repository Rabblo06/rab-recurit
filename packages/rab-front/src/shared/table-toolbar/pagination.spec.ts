import { api } from '../api';
import { fetchAllPages, ListTooLargeError, MAX_PAGE_SIZE, MAX_WALK_PAGES } from './pagination';

jest.mock('../api', () => ({ api: { get: jest.fn() } }));
const get = api.get as jest.Mock;

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}` }));

beforeEach(() => get.mockReset());

it('walks every page of 200 until total, so nothing past the first page is silently dropped', async () => {
  const all = rows(450);
  get.mockImplementation(async (_url: string, { params }: { params: { page: number; limit: number } }) => ({
    data: { data: all.slice((params.page - 1) * params.limit, params.page * params.limit), total: all.length },
  }));
  const result = await fetchAllPages<{ id: string }>('/shifts', { from: 'a', to: 'b' });
  expect(result).toHaveLength(450);
  expect(get.mock.calls.map(([, o]) => o.params)).toEqual([
    { from: 'a', to: 'b', page: 1, limit: MAX_PAGE_SIZE },
    { from: 'a', to: 'b', page: 2, limit: MAX_PAGE_SIZE },
    { from: 'a', to: 'b', page: 3, limit: MAX_PAGE_SIZE },
  ]);
});

it('one short page is one request; a bare array is returned as is', async () => {
  get.mockResolvedValueOnce({ data: { data: rows(3), total: 3 } });
  expect(await fetchAllPages('/venues')).toHaveLength(3);
  get.mockResolvedValueOnce({ data: rows(2) });
  expect(await fetchAllPages('/job-roles')).toHaveLength(2);
  expect(get).toHaveBeenCalledTimes(2);
});

it('stops on a full last page whose total is reached (no extra empty request)', async () => {
  get.mockResolvedValueOnce({ data: { data: rows(200), total: 200 } });
  expect(await fetchAllPages('/staff')).toHaveLength(200);
  expect(get).toHaveBeenCalledTimes(1);
});

it('fails loudly instead of truncating a list too large to walk', async () => {
  get.mockImplementation(async () => ({ data: { data: rows(MAX_PAGE_SIZE) } }));
  await expect(fetchAllPages('/attendance')).rejects.toBeInstanceOf(ListTooLargeError);
  expect(get).toHaveBeenCalledTimes(MAX_WALK_PAGES);
});
