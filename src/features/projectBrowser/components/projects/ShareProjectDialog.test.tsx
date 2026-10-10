// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => false),
  removeMutate: vi.fn(),
}));

vi.mock('@/shared/lib/appDialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: () => {} }));
vi.mock('../../queries/projectSharing', () => ({
  useProjectShare: () => ({
    data: {
      isOwner: true,
      shared: true,
      members: [
        { userId: 'owner', name: 'Ada', email: 'ada@example.test', role: 'owner' },
        { userId: 'ed1', name: 'Bob', email: 'bob@example.test', role: 'editor' },
      ],
    },
    isLoading: false,
  }),
  useInviteProjectEditor: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRemoveProjectEditor: () => ({ isPending: false, mutate: mocks.removeMutate }),
  useLeaveSharedProject: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

const { ShareProjectDialog } = await import('./ShareProjectDialog');

let view: RenderedComponent | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  vi.clearAllMocks();
});

describe('ShareProjectDialog (A14-4)', () => {
  it('retirer un éditeur demande confirmation ; annuler ne retire rien, confirmer retire', async () => {
    view = renderComponent(
      <ShareProjectDialog projectId="p1" projectName="Tour" anchorEl={null} userId="owner" onClose={() => {}} />,
    );
    const removeButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Retirer l’accès à Bob"]')!;
    expect(removeButton).not.toBeNull();

    await act(async () => { removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.removeMutate).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await act(async () => { removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.removeMutate).toHaveBeenCalledWith({ id: 'p1', memberId: 'ed1' });
  });
});
