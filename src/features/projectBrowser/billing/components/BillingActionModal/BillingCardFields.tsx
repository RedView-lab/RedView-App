import {
  CardCvcElement,
  CardExpiryElement,
  CardNumberElement,
} from '@stripe/react-stripe-js';
import { useAppI18n } from '@/shared/i18n';
import { AccountSelect, type AccountSelectOption } from '../../../account/components';
import { CountryFlag, stripeCardElementStyle } from './billingModalStyles';

interface BillingCardFieldsProps {
  cardholderName: string;
  onCardholderNameChange: (value: string) => void;
  countryCode: string;
  onCountryCodeChange: (value: string) => void;
  countryOptions: readonly AccountSelectOption[];
  selectedCountryOption?: AccountSelectOption;
}

export function BillingCardFields({
  cardholderName,
  onCardholderNameChange,
  countryCode,
  onCountryCodeChange,
  countryOptions,
  selectedCountryOption,
}: BillingCardFieldsProps) {
  const { t } = useAppI18n();

  return (
    <div className="rvpb-billing-page__custom-card-fields">
      <div className="rvpb-billing-page__field-row">
        <label className="rvpb-billing-page__field rvpb-billing-page__field--wide">
          <span className="rvpb-billing-page__field-label">
            {t('Numéro de carte')} <span className="rvpb-billing-page__field-required">*</span>
          </span>
          <span className="rvpb-billing-page__stripe-shell">
            <div className="rvpb-billing-page__stripe-input">
              <CardNumberElement
                options={{
                  disableLink: true,
                  showIcon: true,
                  style: stripeCardElementStyle,
                }}
              />
            </div>
          </span>
        </label>

        <label className="rvpb-billing-page__field rvpb-billing-page__field--narrow">
          <span className="rvpb-billing-page__field-label">
            {t('CVV')} <span className="rvpb-billing-page__field-required">*</span>
          </span>
          <span className="rvpb-billing-page__stripe-shell">
            <div className="rvpb-billing-page__stripe-input">
              <CardCvcElement
                options={{
                  style: stripeCardElementStyle,
                }}
              />
            </div>
          </span>
        </label>
      </div>

      <div className="rvpb-billing-page__field-row">
        <label className="rvpb-billing-page__field rvpb-billing-page__field--full">
          <span className="rvpb-billing-page__field-label">
            {t('Nom complet du titulaire')} <span className="rvpb-billing-page__field-required">*</span>
          </span>
          <input
            className="rvpb-billing-page__text-input"
            type="text"
            autoComplete="cc-name"
            value={cardholderName}
            onChange={(e) => onCardholderNameChange(e.target.value)}
            placeholder={t('Nom complet du titulaire')}
            required
          />
        </label>
      </div>

      <div className="rvpb-billing-page__field-row">
        <label className="rvpb-billing-page__field rvpb-billing-page__field--wide">
          <span className="rvpb-billing-page__field-label">
            {t('Date d’expiration')} <span className="rvpb-billing-page__field-required">*</span>
          </span>
          <span className="rvpb-billing-page__stripe-shell">
            <div className="rvpb-billing-page__stripe-input">
              <CardExpiryElement
                options={{
                  style: stripeCardElementStyle,
                }}
              />
            </div>
          </span>
        </label>

        <div className="rvpb-billing-page__field rvpb-billing-page__field--narrow">
          <span className="rvpb-billing-page__field-label">
            {t('Pays')} <span className="rvpb-billing-page__field-required">*</span>
          </span>
          <AccountSelect
            value={countryCode}
            options={countryOptions}
            onChange={(nextCountry) => onCountryCodeChange(nextCountry)}
            renderValuePrefix={() => <CountryFlag option={selectedCountryOption} />}
            renderOptionPrefix={(option) => <CountryFlag option={option} />}
          />
        </div>
      </div>
    </div>
  );
}
