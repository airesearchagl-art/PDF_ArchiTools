import React from 'react';
import type { RecordCurrency } from '../../utils/drawing-set/currency';
import { currencyLabel } from '../../utils/drawing-set/currency';
import { confirmationText, observationText } from './title-block-labels';

/**
 * How a Sheet's reading and its confirmation stand, in words (M7-P2-B2,
 * B2-D04): the code CurrencyState shown as a badge, with what it means.
 */
export const CurrencyBadge: React.FC<{ kind: 'observation' | 'confirmation'; currency: RecordCurrency }> = ({ kind, currency }) => {
    const label = kind === 'observation' ? observationText(currency) : confirmationText(currency);
    return (
        <span className={`ds-currency is-${label.tone}`} title={label.title} data-ds-currency={kind} data-ds-currency-state={currencyLabel(currency)}>
            {label.text}
        </span>
    );
};
