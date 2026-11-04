import { reactive } from 'vue';
import { api } from './api';

/**
 * 다방 카드의 '주소 보기'. 누른 방 하나의 지번 주소를 서버가 다방에서 받아 저장하고 돌려준다.
 * 받은 주소는 여기 두어 같은 매물의 다른 카드에도 바로 보이고, 다음에 매물 목록을 다시 받으면 서버가 채워 준다.
 */
export const dabangAddresses = reactive(new Map<string, string>());
export const dabangAddressBusy = reactive(new Set<string>());
export const dabangAddressErrors = reactive(new Map<string, string>());

export async function loadDabangAddress(id: string) {
  if (dabangAddressBusy.has(id) || dabangAddresses.has(id)) return;
  dabangAddressBusy.add(id);
  dabangAddressErrors.delete(id);
  try {
    dabangAddresses.set(id, (await api.dabangAddress(id)).address);
  } catch (e) {
    dabangAddressErrors.set(id, e instanceof Error ? e.message : String(e));
  } finally {
    dabangAddressBusy.delete(id);
  }
}
