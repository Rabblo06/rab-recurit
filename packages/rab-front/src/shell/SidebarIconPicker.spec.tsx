import { fireEvent, render, screen } from '@testing-library/react';
import SidebarIconPicker from './SidebarIconPicker';
jest.mock('../shared/components/Popover',()=>({__esModule:true,default:({open,children}:any)=>open?<div>{children}</div>:null}));
test('choosing a color preserves an unspecified original icon',()=>{
 const change=jest.fn(); render(<SidebarIconPicker label="Users" onChange={change}/>);
 fireEvent.click(screen.getByRole('button',{name:'Change icon for Users'}));
 fireEvent.click(screen.getByRole('button',{name:'Choose icon color'}));
 fireEvent.change(screen.getByLabelText('Search colors'),{target:{value:'Ruby'}});
 fireEvent.click(screen.getByRole('option',{name:'Ruby'}));
 expect(change).toHaveBeenCalledWith(undefined,'#e54666');
});
test('choosing an icon keeps the selected color',()=>{
 const change=jest.fn(); render(<SidebarIconPicker label="Folder" icon="folder" color="#e54666" onChange={change}/>);
 fireEvent.click(screen.getByRole('button',{name:'Change icon for Folder'}));
 fireEvent.change(screen.getByLabelText('Search icons'),{target:{value:'heart'}});
 fireEvent.click(screen.getByRole('button',{name:'heart'}));
 expect(change).toHaveBeenCalledWith('heart','#e54666');
});
