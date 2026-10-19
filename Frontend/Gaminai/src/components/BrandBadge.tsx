import type { ComponentPropsWithoutRef } from 'react';
import brandBadgeSrc from '../assets/gaminai-badge.svg';

type BrandBadgeProps = Omit<ComponentPropsWithoutRef<'img'>, 'src'>;

const BrandBadge = ({ alt = 'Gaminai badge', draggable = false, ...props }: BrandBadgeProps) => (
  <img alt={alt} draggable={draggable} src={brandBadgeSrc} {...props} />
);

export default BrandBadge;
