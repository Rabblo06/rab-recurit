import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../shared/api';
import ConfirmEmailChange from './ConfirmEmailChange';

jest.mock('../../shared/api', () => ({ api: { post: jest.fn() } }));
const post = api.post as jest.Mock;

const mount = (search: string) => render(<MemoryRouter initialEntries={[`/confirm-email-change${search}`]}><ConfirmEmailChange /></MemoryRouter>);

beforeEach(() => post.mockReset());

it('does nothing until the person presses Confirm (a link scanner opening the page cannot confirm)', async () => {
  mount('?token=' + 'a'.repeat(64));
  expect(await screen.findByRole('heading', { name: 'Confirm your new sign-in email' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});

it('confirms with the token and tells the person they were signed out everywhere', async () => {
  post.mockResolvedValue({ data: { confirmed: true } });
  mount('?token=' + 'b'.repeat(64));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm this email' }));
  expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith('/email-change/confirm', { token: 'b'.repeat(64) });
  expect(screen.getByText(/signed out everywhere/)).toBeInTheDocument();
});

it('shows the server refusal for an invalid or expired link', async () => {
  post.mockRejectedValue({ response: { data: { message: 'This confirmation link is invalid or has expired.' } } });
  mount('?token=' + 'c'.repeat(64));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm this email' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid or has expired');
});

it('explains an incomplete link without calling the server', () => {
  mount('');
  expect(screen.getByRole('heading', { name: 'This link is incomplete' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});
