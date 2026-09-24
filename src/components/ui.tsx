/**
 * Small shared UI kit so every screen uses the same surfaces, spacing and
 * controls. Keep these presentational: no store access, no services.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS, FONT_SIZE, RADIUS, SPACING, withAlpha } from '../constants';

type IconName = React.ComponentProps<typeof Icon>['name'];

/* ─── Screen header ─────────────────────────────────────────── */
export const ScreenHeader: React.FC<{
  title: string;
  subtitle?: string;
  icon?: IconName;
  right?: React.ReactNode;
}> = ({ title, subtitle, icon, right }) => (
  <View style={styles.header}>
    {icon ? (
      <View style={styles.headerIcon}>
        <Icon name={icon} size={22} color={COLORS.primary} />
      </View>
    ) : null}
    <View style={styles.headerText}>
      <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      {subtitle ? <Text style={styles.headerSubtitle} numberOfLines={2}>{subtitle}</Text> : null}
    </View>
    {right}
  </View>
);

/* ─── Card ──────────────────────────────────────────────────── */
export const Card: React.FC<{
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  tone?: string;
}> = ({ children, style, padded = true, tone }) => (
  <View
    style={[
      styles.card,
      padded && styles.cardPadded,
      tone ? { borderColor: withAlpha(tone, 0.35), backgroundColor: withAlpha(tone, 0.06) } : null,
      style,
    ]}
  >
    {children}
  </View>
);

/* ─── Section label ─────────────────────────────────────────── */
export const SectionLabel: React.FC<{ children: React.ReactNode; style?: StyleProp<TextStyle> }> = ({ children, style }) => (
  <Text style={[styles.sectionLabel, style]}>{children}</Text>
);

export const Hint: React.FC<{ children: React.ReactNode; style?: StyleProp<TextStyle> }> = ({ children, style }) => (
  <Text style={[styles.hint, style]}>{children}</Text>
);

/* ─── Buttons ───────────────────────────────────────────────── */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button: React.FC<{
  label: string;
  onPress: () => void;
  icon?: IconName;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}> = ({ label, onPress, icon, variant = 'secondary', disabled, loading, compact, style, accessibilityHint }) => {
  const palette = {
    primary: { bg: COLORS.primary, border: COLORS.primary, fg: COLORS.onPrimary },
    secondary: { bg: COLORS.surfaceLight, border: COLORS.border, fg: COLORS.text },
    ghost: { bg: 'transparent', border: 'transparent', fg: COLORS.primary },
    danger: { bg: withAlpha(COLORS.error, 0.1), border: withAlpha(COLORS.error, 0.45), fg: COLORS.error },
  }[variant];
  const inactive = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && !inactive && styles.pressed,
        inactive && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : icon ? (
        <Icon name={icon} size={compact ? 16 : 18} color={palette.fg} />
      ) : null}
      <Text style={[styles.buttonLabel, compact && styles.buttonLabelCompact, { color: palette.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
};

export const IconButton: React.FC<{
  icon: IconName;
  onPress: () => void;
  label: string;
  color?: string;
  size?: number;
  disabled?: boolean;
  filled?: boolean;
  style?: StyleProp<ViewStyle>;
}> = ({ icon, onPress, label, color = COLORS.textSecondary, size = 20, disabled, filled, style }) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    hitSlop={8}
    accessibilityRole="button"
    accessibilityLabel={label}
    style={({ pressed }) => [
      styles.iconButton,
      filled && { backgroundColor: COLORS.surfaceLight, borderColor: COLORS.border },
      pressed && styles.pressed,
      disabled && styles.disabled,
      style,
    ]}
  >
    <Icon name={icon} size={size} color={color} />
  </Pressable>
);

/* ─── Pills / badges ────────────────────────────────────────── */
export const Pill: React.FC<{
  label: string;
  icon?: IconName;
  color?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}> = ({ label, icon, color = COLORS.textSecondary, onPress, style }) => {
  const content = (
    <>
      {icon ? <Icon name={icon} size={13} color={color} /> : null}
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>{label}</Text>
    </>
  );
  const pillStyle = [styles.pill, { borderColor: withAlpha(color, 0.3), backgroundColor: withAlpha(color, 0.1) }, style];
  if (!onPress) return <View style={pillStyle}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [...pillStyle, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
};

/* ─── Option chips (single choice) ──────────────────────────── */
export type Option<T extends string | number> = { value: T; label: string; description?: string; icon?: IconName };

export function OptionGroup<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Option<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.optionGroup} accessibilityRole="radiogroup">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: active, disabled: !!disabled }}
            accessibilityLabel={option.label}
            style={({ pressed }) => [
              styles.option,
              active && styles.optionActive,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}
          >
            {option.icon ? (
              <Icon name={option.icon} size={15} color={active ? COLORS.primary : COLORS.textSecondary} />
            ) : null}
            <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ─── Rows ──────────────────────────────────────────────────── */
export const ListRow: React.FC<{
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  destructive?: boolean;
  style?: StyleProp<ViewStyle>;
}> = ({ title, subtitle, icon, iconColor, right, onPress, showChevron, destructive, style }) => {
  const color = destructive ? COLORS.error : iconColor ?? COLORS.primary;
  const body = (
    <>
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: withAlpha(color, 0.12) }]}>
          <Icon name={icon} size={18} color={color} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, destructive && { color: COLORS.error }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right}
      {showChevron ? <Icon name="chevron-right" size={20} color={COLORS.textMuted} /> : null}
    </>
  );
  if (!onPress) return <View style={[styles.row, style]}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, style]}
    >
      {body}
    </Pressable>
  );
};

export const ToggleRow: React.FC<{
  title: string;
  subtitle?: string;
  icon?: IconName;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}> = ({ title, subtitle, icon, value, onValueChange, disabled }) => (
  <ListRow
    title={title}
    subtitle={subtitle}
    icon={icon}
    iconColor={value ? COLORS.primary : COLORS.textSecondary}
    right={(
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: COLORS.surfaceRaised, true: withAlpha(COLORS.primary, 0.55) }}
        thumbColor={value ? COLORS.primary : COLORS.textSecondary}
        ios_backgroundColor={COLORS.surfaceRaised}
        accessibilityLabel={title}
      />
    )}
  />
);

export const Divider: React.FC<{ style?: StyleProp<ViewStyle> }> = ({ style }) => <View style={[styles.divider, style]} />;

/* ─── Empty state ───────────────────────────────────────────── */
export const EmptyState: React.FC<{
  icon: IconName;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}> = ({ icon, title, subtitle, action }) => (
  <View style={styles.empty}>
    <View style={styles.emptyIcon}>
      <Icon name={icon} size={34} color={COLORS.primary} />
    </View>
    <Text style={styles.emptyTitle}>{title}</Text>
    {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    {action}
  </View>
);

/* ─── Styles ────────────────────────────────────────────────── */
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.md,
  },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.primary, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.primary, 0.25),
  },
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: COLORS.text,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: FONT_SIZE.sm,
    color: COLORS.textSecondary,
    marginTop: 2,
    lineHeight: 17,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  cardPadded: {
    padding: SPACING.md,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.textMuted,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
  },
  hint: {
    fontSize: FONT_SIZE.sm,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },
  button: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
  },
  buttonCompact: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: RADIUS.sm,
  },
  buttonLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  buttonLabelCompact: {
    fontSize: 13,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    maxWidth: 200,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    flexShrink: 1,
  },
  optionGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    maxWidth: '100%',
  },
  optionActive: {
    borderColor: COLORS.primary,
    backgroundColor: withAlpha(COLORS.primary, 0.14),
  },
  optionText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: '600',
    flexShrink: 1,
  },
  optionTextActive: {
    color: COLORS.primary,
    fontWeight: '800',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    minHeight: 52,
  },
  rowPressed: {
    opacity: 0.65,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
  },
  rowSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
    lineHeight: 16,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: SPACING.xl,
  },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.primary, 0.08),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.primary, 0.25),
    marginBottom: 6,
  },
  emptyTitle: {
    fontSize: FONT_SIZE.xl,
    fontWeight: '800',
    color: COLORS.text,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: FONT_SIZE.md,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
});
