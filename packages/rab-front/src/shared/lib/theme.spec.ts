import { api } from '../api';
import { initTheme } from './theme';

jest.mock('../api', () => ({
  api: { get: jest.fn(), patch: jest.fn() },
}));

const mockApi = api as unknown as { get: jest.Mock; patch: jest.Mock };

describe('initTheme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockApi.get.mockReset();
    // jsdom doesn't implement matchMedia; applyTheme's 'system' resolution needs it.
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
  });

  it('does not call the API when there is no session — avoids a doomed 401 on the login screen', () => {
    initTheme();
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('fetches server-side preferences when a session exists', () => {
    window.localStorage.setItem('accessToken', 'token-1');
    mockApi.get.mockResolvedValue({ data: { theme: 'dark' } });

    initTheme();

    expect(mockApi.get).toHaveBeenCalledWith('/profile/preferences');
  });
});
