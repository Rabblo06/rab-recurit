import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EmailChangeStepUpDialog from './EmailChangeStepUpDialog';

it('asks for the administrator’s own password, explains the change is pending, and submits it', async () => {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  render(<EmailChangeStepUpDialog newEmail="new@example.test" onSubmit={onSubmit} onCancel={jest.fn()} />);
  expect(screen.getByText(/keeps its current email until that link is used/)).toBeInTheDocument();
  const send = screen.getByRole('button', { name: 'Send confirmation link' });
  expect(send).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'my-own-password' } });
  fireEvent.click(send);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('my-own-password'));
});

it('shows a server refusal (wrong password, protected account, no-password sign-in) and stays open', async () => {
  const onSubmit = jest.fn().mockRejectedValue({ response: { data: { message: 'Re-enter your current password to continue.' } } });
  render(<EmailChangeStepUpDialog newEmail="new@example.test" onSubmit={onSubmit} onCancel={jest.fn()} />);
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Re-enter your current password');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
