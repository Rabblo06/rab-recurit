import { createHash } from 'node:crypto';

import { CORE_REFERENCE_OBJECTS, CREWFLOW_STANDARD_OBJECT_DEFINITIONS, CREWFLOW_STANDARD_OBJECTS } from '../../../database/typeorm/workspace-schema/standard-objects/standard-object-definitions';
import { WORKSPACE_TABLES } from '../../../database/typeorm/workspace-schema/workspace-tables';
import type { StandardObjectDefinition } from './standard-object-definition';
import {
  desiredStandardMetadata,
  FieldRow,
  isEmptyPlan,
  NO_CUSTOM_FIELD_TABLES,
  ObjectRow,
  OptionRow,
  PAYROLL_ATTENDANCE_SYSTEM_TABLES,
  planStandardObjectSync,
  StandardObjectSyncError,
  StoredField,
  StoredObject,
  StoredOption,
  validateStandardDefinitions,
} from './standard-object-plan';
import { catalogProblems, CatalogColumn } from './standard-object-sync';
import { standardUniversalIdentifier } from './standard-universal-identifier';

/** Metadata engine M1 / E2: the standard-object definitions and the pure sync planner (no database). */
const D = CREWFLOW_STANDARD_OBJECT_DEFINITIONS;
const desired = desiredStandardMetadata(D.standard, D.coreReferences);
let n = 0;
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const empty = { objects: [] as StoredObject[], fields: [] as StoredField[], options: [] as StoredOption[] };

/** What the database holds after a plan was applied (the sync's INSERT defaults included). */
function storedAfter(plan: { insertObjects: ObjectRow[]; insertFields: FieldRow[]; insertOptions: OptionRow[] }) {
  return {
    objects: plan.insertObjects.map((o) => ({ ...o, is_custom: false }) as StoredObject),
    fields: plan.insertFields.map((f) => ({ ...f, is_custom: false, is_locked: true, description: null, settings: { ...f.settings } }) as StoredField),
    options: plan.insertOptions.map((o) => ({ ...o })),
  };
}

describe('M1 / E2: the standard-object definitions', () => {
  it('are valid: exactly the 21 workspace tables, unique names, locks per §0.3 and owner decisions D1–D4', () => {
    expect(() => validateStandardDefinitions(D.standard, D.coreReferences, WORKSPACE_TABLES)).not.toThrow();
    expect(CREWFLOW_STANDARD_OBJECTS.map((o) => o.table)).toEqual([...WORKSPACE_TABLES]);
    expect(CORE_REFERENCE_OBJECTS.map((o) => o.nameSingular)).toEqual(['workspaceMember', 'managerProfile', 'storedFile', 'payrollCalendarPeriod']);
  });

  it('the seven §0.3 objects are system objects: no custom fields, every field read-only; the junctions likewise (S1)', () => {
    const system = CREWFLOW_STANDARD_OBJECTS.filter((o) => o.kind === 'system').map((o) => o.table).sort();
    expect(system).toEqual([...PAYROLL_ATTENDANCE_SYSTEM_TABLES].sort());
    for (const o of CREWFLOW_STANDARD_OBJECTS.filter((x) => x.kind !== 'standard')) {
      expect(o.allowsCustomFields).toBe(false);
      for (const f of o.fields) expect([o.table, f.column, f.isUIReadOnly]).toEqual([o.table, f.column, true]);
    }
    const objects = new Map(desired.objects.map((o) => [o.physical_table, o]));
    for (const t of PAYROLL_ATTENDANCE_SYSTEM_TABLES) expect(objects.get(t)).toMatchObject({ is_system: true, allows_custom_fields: false });
    expect(CREWFLOW_STANDARD_OBJECTS.filter((o) => o.kind === 'junction').map((o) => o.table).sort()).toEqual(['manager_venue', 'shift_request_staff', 'venue_manager_staff']);
  });

  it('custom fields exactly on the six objects the owner allowed (D1–D4)', () => {
    expect(CREWFLOW_STANDARD_OBJECTS.filter((o) => o.allowsCustomFields).map((o) => o.table).sort()).toEqual(
      ['job_offer', 'job_role', 'shift', 'shift_staff_review', 'staff_profile', 'venue'],
    );
    for (const t of NO_CUSTOM_FIELD_TABLES) expect(CREWFLOW_STANDARD_OBJECTS.find((o) => o.table === t)?.allowsCustomFields).toBe(false);
  });

  it('every status column is read-only (S13); every pence column is NUMBER bigint money, read-only, sensitive (payroll.view), never CURRENCY', () => {
    const fields = CREWFLOW_STANDARD_OBJECTS.flatMap((o) => o.fields.map((f) => ({ t: o.table, ...f })));
    const status = fields.filter((f) => f.type === 'SELECT' && (f.column === 'status' || f.column.endsWith('_status')));
    expect(status).toHaveLength(11);
    for (const f of status) expect([f.t, f.column, f.isUIReadOnly]).toEqual([f.t, f.column, true]);
    const money = fields.filter((f) => f.column.endsWith('_pence'));
    expect(money).toHaveLength(14);
    for (const f of money) expect({ type: f.type, pg: f.pgType, money: f.settings?.money, ro: f.isUIReadOnly, auth: f.sensitive?.authority }).toEqual({ type: 'NUMBER', pg: 'bigint', money: true, ro: true, auth: 'payroll.view' });
    expect(fields.some((f) => (f.type as string) === 'CURRENCY')).toBe(false);
  });

  it('tenant columns are never fields; every built-in field the sync writes is locked (the INSERT hard-codes is_locked = true)', () => {
    for (const o of CREWFLOW_STANDARD_OBJECTS) for (const f of o.fields) expect(['organisation_id', 'workspace_id']).not.toContain(f.column);
    expect(desired.fields.every((f) => f.universal_identifier)).toBe(true);
  });

  it('every workspace relation has exactly one inverse and the pair points both ways (Twenty relation pairs)', () => {
    const byUid = new Map(desired.fields.map((f) => [f.universal_identifier, f]));
    const manyToOne = desired.fields.filter((f) => f.type === 'RELATION' && f.settings.relationType === 'MANY_TO_ONE');
    const withInverse = manyToOne.filter((f) => f.relation_target_field_uid);
    expect(withInverse).toHaveLength(34);
    for (const f of withInverse) {
      const inv = byUid.get(f.relation_target_field_uid!)!;
      expect(inv.settings.relationType).toBe('ONE_TO_MANY');
      expect(inv.physical_column).toBeNull();
      expect(inv.relation_target_field_uid).toBe(f.universal_identifier);
      expect(inv.object_uid).toBe(f.relation_target_object_uid);
      expect(inv.relation_target_object_uid).toBe(f.object_uid);
    }
    // Relations into core have no inverse and target a core reference object.
    const core = new Set(desired.objects.filter((o) => CORE_REFERENCE_OBJECTS.some((c) => c.table === o.physical_table)).map((o) => o.universal_identifier));
    for (const f of manyToOne.filter((x) => !x.relation_target_field_uid)) expect(core.has(f.relation_target_object_uid!)).toBe(true);
  });

  it('universal identifiers are stable: pinned digest (a renamed key or a changed derivation fails here)', () => {
    expect(standardUniversalIdentifier('object:staff_profile')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const all = [...desired.objects.map((o) => `o ${o.physical_table} ${o.universal_identifier}`), ...desired.fields.map((f) => `f ${f.name} ${f.universal_identifier}`)].sort();
    expect(new Set(all.map((l) => l.split(' ')[2])).size).toBe(all.length);
    expect({ objects: desired.objects.length, fields: desired.fields.length }).toEqual({ objects: 25, fields: 310 + 34 });
    expect(createHash('sha256').update(all.join('\n')).digest('hex')).toBe(UID_DIGEST);
  });
});

/** sha256 of the sorted (kind, name, universal identifier) lines; regenerate ONLY for a reviewed, deliberate change. */
const UID_DIGEST = 'f64afef63580a88fe41c4f0b2469daa9934388369661143a23e34318190ab0db';

describe('M1 / E2: the sync planner', () => {
  it('empty workspace → inserts every object, field and option; ids are fresh and each row is written once', () => {
    const plan = planStandardObjectSync(desired, empty, ids);
    expect(plan.insertObjects).toHaveLength(25);
    expect(plan.insertFields).toHaveLength(desired.fields.length);
    expect(plan.insertOptions.length).toBe(desired.fields.reduce((k, f) => k + f.options.length, 0));
    expect(plan.updateObjects.length + plan.updateFields.length + plan.updateOptions.length).toBe(0);
    const staff = plan.insertObjects.find((o) => o.physical_table === 'staff_profile')!;
    expect(plan.insertFields.find((f) => f.id === staff.label_identifier_field_id)?.physical_column).toBe('staff_ref');
  });

  it('a re-run plans nothing (idempotent)', () => {
    const first = planStandardObjectSync(desired, empty, ids);
    expect(isEmptyPlan(planStandardObjectSync(desired, storedAfter(first), ids))).toBe(true);
  });

  it('MT-26: a stored lock that was removed is restored; a changed label is put back; nothing else is touched', () => {
    const stored = storedAfter(planStandardObjectSync(desired, empty, ids));
    const status = stored.fields.find((f) => f.physical_column === 'status' && f.name === 'status')!;
    status.is_locked = false;
    status.is_ui_read_only = false;
    const venue = stored.objects.find((o) => o.physical_table === 'venue')!;
    venue.label_plural = 'Sites';
    const plan = planStandardObjectSync(desired, stored, ids);
    expect(plan.updateFields.map((f) => f.id)).toEqual([status.id]);
    expect(plan.updateFields[0]!.is_ui_read_only).toBe(true);
    expect(plan.updateObjects.map((o) => [o.id, o.label_plural])).toEqual([[venue.id, 'Venues']]);
    expect(plan.insertObjects.length + plan.insertFields.length + plan.insertOptions.length).toBe(0);
  });

  it('custom objects and custom fields are left untouched; a name clash with one is refused', () => {
    const stored = storedAfter(planStandardObjectSync(desired, empty, ids));
    const staff = stored.objects.find((o) => o.physical_table === 'staff_profile')!;
    stored.objects.push({ ...staff, id: ids(), universal_identifier: null, is_custom: true, name_singular: 'shoe', name_plural: 'shoes', physical_table: 'c_abc', is_system: false });
    stored.fields.push({ ...stored.fields[0]!, id: ids(), object_metadata_id: staff.id, universal_identifier: null, is_custom: true, name: 'shoeSize', physical_column: 'cf_abc', is_locked: false });
    expect(isEmptyPlan(planStandardObjectSync(desired, stored, ids))).toBe(true);

    const fresh = { ...empty, objects: [{ ...staff, id: ids(), universal_identifier: null, is_custom: true, name_singular: 'venue', name_plural: 'venueThings', physical_table: 'c_x' }] };
    expect(() => planStandardObjectSync(desired, fresh, ids)).toThrow(StandardObjectSyncError);
  });

  it('fails closed: unknown stored standard rows, changed immutable properties and removed options are refused, never deleted', () => {
    const base = () => storedAfter(planStandardObjectSync(desired, empty, ids));
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as StandardObjectSyncError).code;
      }
      return 'no error';
    };
    const a = base();
    a.fields.push({ ...a.fields[1]!, id: ids(), universal_identifier: standardUniversalIdentifier('field:venue.gone'), name: 'gone', physical_column: 'gone' });
    expect(code(() => planStandardObjectSync(desired, a, ids))).toBe('UNKNOWN_STANDARD_FIELD');
    const b = base();
    b.fields.find((f) => f.physical_column === 'earned_pence')!.type = 'CURRENCY';
    expect(code(() => planStandardObjectSync(desired, b, ids))).toBe('IMMUTABLE_DIVERGENCE');
    const c = base();
    c.objects.find((o) => o.physical_table === 'payroll_record')!.is_system = false;
    expect(code(() => planStandardObjectSync(desired, c, ids))).toBe('IMMUTABLE_DIVERGENCE');
    const d = base();
    d.options.push({ ...d.options[0]!, id: ids(), value: 'retired' });
    expect(code(() => planStandardObjectSync(desired, d, ids))).toBe('UNKNOWN_STANDARD_OPTION');
    const e = base();
    e.objects.push({ ...e.objects[0]!, id: ids(), universal_identifier: standardUniversalIdentifier('object:retired') });
    expect(code(() => planStandardObjectSync(desired, e, ids))).toBe('UNKNOWN_STANDARD_OBJECT');
  });

  it('is_active is workspace-owned for standard objects, always true for system objects', () => {
    const stored = storedAfter(planStandardObjectSync(desired, empty, ids));
    stored.objects.find((o) => o.physical_table === 'venue')!.is_active = false;
    stored.objects.find((o) => o.physical_table === 'payslip')!.is_active = false;
    const plan = planStandardObjectSync(desired, stored, ids);
    expect(plan.updateObjects.map((o) => [o.physical_table, o.is_active])).toEqual([['payslip', true]]);
  });

  it('the definition validator refuses an unlocked payroll object, custom fields where the owner said no, and a writable status', () => {
    const tweak = (table: string, change: (o: StandardObjectDefinition) => StandardObjectDefinition) =>
      D.standard.map((o) => (o.table === table ? change(o) : o));
    const v = (s: readonly StandardObjectDefinition[]) => () => validateStandardDefinitions(s, D.coreReferences, WORKSPACE_TABLES);
    expect(v(tweak('payroll_record', (o) => ({ ...o, kind: 'standard' })))).toThrow(/system object/);
    expect(v(tweak('venue_role_rate', (o) => ({ ...o, allowsCustomFields: true })))).toThrow(/custom fields/);
    expect(v(tweak('shift', (o) => ({ ...o, fields: o.fields.map((f) => (f.column === 'status' ? { ...f, isUIReadOnly: false } : f)) })))).toThrow(/S13/);
    expect(v(tweak('job_role', (o) => ({ ...o, fields: o.fields.map((f) => (f.column === 'default_rate_pence' ? { ...f, settings: { dataType: 'bigint' as const } } : f)) })))).toThrow(/money/);
    expect(v(D.standard.slice(1))).toThrow(/exactly the 21/);
  });
});

describe('M1 / E2: catalog comparison (metadata matches the 21 tables exactly)', () => {
  const catalog = (): CatalogColumn[] =>
    D.standard.flatMap((o) => [
      { t: o.table, c: 'organisation_id', ty: 'uuid', nn: true },
      { t: o.table, c: 'workspace_id', ty: 'uuid', nn: true },
      ...o.fields.map((f) => ({ t: o.table, c: f.column, ty: f.pgType, nn: !f.nullable })),
    ]);
  it('the definitions themselves match', () => expect(catalogProblems(D, catalog())).toEqual([]));
  it('a column without a field, a changed type or nullability, a missing column or table, an unknown table: each reported', () => {
    const c = catalog();
    c.push({ t: 'attendance', c: 'bonus_pence', ty: 'bigint', nn: false });
    c.find((x) => x.t === 'shift' && x.c === 'notes')!.ty = 'character varying';
    c.find((x) => x.t === 'venue' && x.c === 'name')!.nn = false;
    const withoutPhoto = c.filter((x) => !(x.t === 'venue' && x.c === 'photo_file_id'));
    withoutPhoto.push({ t: 'mystery', c: 'id', ty: 'uuid', nn: true });
    expect(catalogProblems(D, withoutPhoto.filter((x) => x.t !== 'user_note')).sort()).toEqual([
      'attendance.bonus_pence has no standard field',
      'missing table user_note',
      'shift.notes is character varying, declared text',
      'unexpected table mystery',
      'venue.name nullability differs',
      'venue.photo_file_id is declared but not in the table',
    ]);
  });
  it('custom tables (c_*) are ignored; custom columns (cf_*) only on objects that allow custom fields', () => {
    const c = [...catalog(), { t: 'c_abc', c: 'id', ty: 'uuid', nn: true }, { t: 'venue', c: 'cf_x1', ty: 'text', nn: false }];
    expect(catalogProblems(D, c)).toEqual([]);
    expect(catalogProblems(D, [...catalog(), { t: 'payroll_record', c: 'cf_x1', ty: 'text', nn: false }])).toEqual(['payroll_record.cf_x1 has no standard field']);
  });
});
