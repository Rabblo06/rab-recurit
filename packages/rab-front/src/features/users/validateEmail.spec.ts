import { isValidEmail } from './validateEmail';

describe('isValidEmail', () => {
  // TEST 13
  it.each(['abc', 'abc@', 'abc@gmail', 'abc@gmail.', '@ gmail.com', 'foo@bar'])(
    'rejects %s',
    (value) => {
      expect(isValidEmail(value)).toBe(false);
    },
  );

  // TEST 14
  it.each(['name@example.com', 'first.last@example.co.uk'])(
    'accepts %s',
    (value) => {
      expect(isValidEmail(value)).toBe(true);
    },
  );

  it('rejects an empty string without throwing', () => {
    expect(isValidEmail('')).toBe(false);
  });
});
