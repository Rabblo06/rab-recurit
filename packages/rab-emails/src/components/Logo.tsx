import { Column, Row, Section, Text } from '@react-email/components';

import { emailTheme } from './styles';

/**
 * A plain colored-box letter mark — no hotlinked external image (nothing
 * for an email client to block/flag, nothing that depends on an external
 * host staying up), matching the same "R" mark already used in the mobile
 * app's own Welcome/SetPassword screens for visual consistency.
 */
export function Logo() {
  return (
    <Section style={{ marginBottom: '32px' }}>
      <Row>
        <Column align="left">
          <table role="presentation" cellPadding={0} cellSpacing={0} style={{ borderCollapse: 'collapse' }}>
            <tbody>
              <tr>
                <td
                  width={40}
                  height={40}
                  style={{
                    background: emailTheme.accent.default,
                    borderRadius: emailTheme.border.radius.sm,
                    textAlign: 'center',
                    verticalAlign: 'middle',
                  }}
                >
                  <Text
                    style={{
                      color: emailTheme.font.colors.inverted,
                      fontFamily: emailTheme.font.family,
                      fontSize: '18px',
                      fontWeight: emailTheme.font.weight.bold,
                      margin: 0,
                      lineHeight: '40px',
                    }}
                  >
                    R
                  </Text>
                </td>
              </tr>
            </tbody>
          </table>
        </Column>
      </Row>
    </Section>
  );
}

export default Logo;
