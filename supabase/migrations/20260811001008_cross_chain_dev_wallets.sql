alter table public.collection_wallets
  drop constraint collection_wallets_relationship_check;

alter table public.collection_wallets
  add constraint collection_wallets_relationship_check check (relationship in (
    'contract_creator', 'deployment_initiator', 'contract_owner',
    'royalty_receiver', 'mint_proceeds_receiver', 'withdrawal_destination',
    'treasury', 'likely_dev', 'tracked_fallback', 'cross_chain_dev'
  ));
