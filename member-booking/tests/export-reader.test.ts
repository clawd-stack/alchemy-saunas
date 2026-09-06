import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types, deliberately dependency-free
import { parseExport } from '../web/admin/export-reader.js';

/**
 * Reading a membership export.
 *
 * The file comes out of a system nobody here can see, so the interesting cases
 * are all the ways a real export differs from a tidy one: a byte order mark
 * from Excel, CRLF endings, a comma inside a quoted name, a tab separated file
 * saved as .csv, a header spelled something other than "email".
 */

const HEADER = 'Email Address,First Name,Last Name,Membership Type,Status';

describe('parseExport', () => {
  it('reads a plain export and says which column it took each field from', () => {
    const { rows, headers } = parseExport(
      `${HEADER}\nada@example.com,Ada,Active,Unlimited,Active\nben@example.com,Ben,Byte,Casual,Active\n`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      email: 'ada@example.com', firstName: 'Ada', lastName: 'Active',
      membershipType: 'Unlimited', status: 'Active',
    });
    expect(headers.email).toBe('Email Address');
    expect(headers.membershipType).toBe('Membership Type');
  });

  it('survives what Excel does to a file', () => {
    // A byte order mark, CRLF endings, and a trailing blank line.
    const { rows } = parseExport(`﻿${HEADER}\r\nada@example.com,Ada,Active,Unlimited,Active\r\n\r\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('ada@example.com');
  });

  it('keeps a comma that is inside a quoted field', () => {
    const { rows } = parseExport(
      `Email,Name,Membership\ncas@example.com,"Casual, Cassandra","Off peak, 10 pack"\n`,
    );
    expect(rows[0].name).toBe('Casual, Cassandra');
    expect(rows[0].membershipType).toBe('Off peak, 10 pack');
  });

  it('reads a doubled quote inside a quoted field as one quote', () => {
    const { rows } = parseExport(`Email,Name\nnic@example.com,"Nicholas ""Nic"" Byte"\n`);
    expect(rows[0].name).toBe('Nicholas "Nic" Byte');
  });

  it('takes a tab separated file, which is what a spreadsheet often gives', () => {
    const { rows } = parseExport('Email\tName\tMembership\nada@example.com\tAda Active\tUnlimited\n');
    expect(rows[0]).toMatchObject({ email: 'ada@example.com', name: 'Ada Active', membershipType: 'Unlimited' });
  });

  it('recognises the header spellings an export is likely to use', () => {
    for (const header of ['email', 'E-Mail', 'Primary Email', 'Member Email', 'EmailAddress']) {
      const { rows } = parseExport(`${header},Plan\nada@example.com,Unlimited\n`);
      expect(rows[0].email, header).toBe('ada@example.com');
      expect(rows[0].membershipType, header).toBe('Unlimited');
    }
  });

  it('refuses a file with no email column, and says what it did find', () => {
    // Better than importing nothing and reporting success, which is what a
    // silent skip of every row would look like from the outside.
    expect(() => parseExport('Name,Plan\nAda Active,Unlimited\n')).toThrow(/No email column found.*Name, Plan/s);
  });

  it('refuses an empty file and a header with no rows under it', () => {
    expect(() => parseExport('   ')).toThrow(/nothing to read/i);
    expect(() => parseExport(HEADER)).toThrow(/header row and nothing else/i);
  });

  it('leaves a missing column empty rather than guessing', () => {
    const { rows } = parseExport('Email\nada@example.com\n');
    expect(rows[0]).toMatchObject({ email: 'ada@example.com', membershipType: '', status: '', name: '' });
  });
});
