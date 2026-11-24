import {render,screen,fireEvent} from '@testing-library/react';
import TimeInput from './TimeInput';
it('accepts valid 24-hour input and does not emit invalid time',()=>{
 const onChange=jest.fn();render(<TimeInput label="Start time" value="09:00" onChange={onChange}/>);
 const input=screen.getByRole('textbox',{name:'Start time'});
 fireEvent.change(input,{target:{value:'15:30'}});fireEvent.blur(input);expect(onChange).toHaveBeenLastCalledWith('15:30');
 onChange.mockClear();fireEvent.change(input,{target:{value:'25:90'}});fireEvent.blur(input);expect(onChange).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeInTheDocument();
 fireEvent.change(input,{target:{value:''}});fireEvent.blur(input);expect(onChange).toHaveBeenLastCalledWith('');
});
