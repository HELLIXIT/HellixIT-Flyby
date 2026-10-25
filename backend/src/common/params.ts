import { BadRequestException } from '@nestjs/common';

export function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n)) throw new BadRequestException(`${name} must be a number`);
  if (n < min || n > max) throw new BadRequestException(`${name} must be between ${min} and ${max}`);
  return n;
}

export function optNum(v: unknown, name: string, min: number, max: number, def: number): number {
  return v === undefined || v === '' ? def : num(v, name, min, max);
}
