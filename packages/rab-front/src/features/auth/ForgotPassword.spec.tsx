import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';
import { api } from '../../shared/api';
jest.mock('../../shared/api',()=>({api:{post:jest.fn()}}));
const post=api.post as jest.Mock;
beforeEach(()=>post.mockReset());
function mount(){render(<MemoryRouter initialEntries={['/forgot-password?applicationTarget=staff_app']}><ForgotPassword /></MemoryRouter>);fireEvent.change(screen.getByLabelText('Email'),{target:{value:'person@example.test'}});fireEvent.click(screen.getByRole('button',{name:'Send reset link'}));}
it('only shows the inbox state after the real request succeeds; resend invokes the same endpoint again',async()=>{
  post.mockResolvedValue({data:{}});mount();
  expect(await screen.findByRole('heading',{name:'Check your inbox'})).toBeInTheDocument();
  expect(screen.getByText(/If there’s an account/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Resend email'}));
  await waitFor(()=>expect(post).toHaveBeenCalledTimes(2));
  expect(post).toHaveBeenLastCalledWith('/auth/forgot-password',{email:'person@example.test',applicationTarget:'staff_app'});
});
it('a network failure leaves the form and email intact, without claiming an email was sent',async()=>{
  post.mockRejectedValue(new Error('offline'));mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t send the request');
  expect(screen.queryByRole('heading',{name:'Check your inbox'})).toBeNull();
  expect(screen.getByLabelText('Email')).toHaveValue('person@example.test');
});
it('a failed resend reports the failure in the inbox screen',async()=>{
  post.mockResolvedValueOnce({data:{}}).mockRejectedValueOnce(new Error('offline'));mount();
  fireEvent.click(await screen.findByRole('button',{name:'Resend email'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t send the request');
});
