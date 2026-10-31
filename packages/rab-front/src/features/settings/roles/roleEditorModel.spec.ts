import { api } from '../../../shared/api';
import { roleApi } from './roleEditorModel';

jest.mock('../../../shared/api', () => ({ api: { get: jest.fn() } }));
const get = api.get as jest.Mock;

it('Phase C1: the venue filter options walk every page of 200 (the old ?limit=1000 is now a 400), so no venue is missing', async () => {
  const venues = Array.from({ length: 230 }, (_, i) => ({ id: `v${i}`, name: `Venue ${i}` }));
  get.mockImplementation(async (url: string, config?: { params?: { page?: number; limit?: number } }) => {
    const limit = config?.params?.limit ?? 50;
    if (url !== '/venues' || limit > 200) throw Object.assign(new Error('400'), { response: { status: 400 } });
    const page = config?.params?.page ?? 1;
    return { data: { data: venues.slice((page - 1) * limit, page * limit), total: venues.length } };
  });
  const result = await roleApi.venues();
  expect(result).toHaveLength(230);
  expect(get.mock.calls.map(([, c]) => c.params)).toEqual([{ page: 1, limit: 200 }, { page: 2, limit: 200 }]);
});
