import { render } from '@testing-library/react';
import NavigationIndicator, { NavigationIndicatorScope } from './NavigationIndicator';
jest.mock('../motion', () => ({ spring: {type:'spring'}, usePrefersReducedMotion: () => true }));
function Example({ parent=true, child=false, folder=false }: {parent?:boolean;child?:boolean;folder?:boolean}) {
  return <NavigationIndicatorScope><div data-testid="parent"><NavigationIndicator active={parent} priority={7}/></div><NavigationIndicatorScope><div data-testid="child"><NavigationIndicator active={child} priority={15}/></div></NavigationIndicatorScope><div data-testid="folder"><NavigationIndicator active={folder} priority={10000}/></div></NavigationIndicatorScope>;
}
test('nested scopes share one winner and specific destinations supersede parent route matches', () => {
  const view=render(<Example/>);
  expect(view.container.querySelectorAll('[data-navigation-indicator]')).toHaveLength(1);
  expect(view.getByTestId('parent').firstChild).not.toBeNull();
  view.rerender(<Example child/>);
  expect(view.container.querySelectorAll('[data-navigation-indicator]')).toHaveLength(1);
  expect(view.getByTestId('child').firstChild).not.toBeNull();
  expect(view.getByTestId('parent').firstChild).toBeNull();
  view.rerender(<Example child folder/>);
  expect(view.getByTestId('folder').firstChild).not.toBeNull();
  view.rerender(<Example/>);
  expect(view.getByTestId('parent').firstChild).not.toBeNull();
});
test('reduced motion uses a plain indicator and unmount removes stale candidates', () => {
  const view=render(<NavigationIndicatorScope><NavigationIndicator active priority={2}/><NavigationIndicator active={false}/></NavigationIndicatorScope>);
  const indicator=view.container.querySelector('[data-navigation-indicator]');
  expect(indicator?.tagName).toBe('SPAN');
  expect(indicator).not.toHaveAttribute('style');
  view.rerender(<NavigationIndicatorScope><NavigationIndicator active={false}/></NavigationIndicatorScope>);
  expect(view.container.querySelector('[data-navigation-indicator]')).toBeNull();
});
