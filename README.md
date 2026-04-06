# Warehouse management system
Manage your warehouse operations with a Web service

## Features
1. keeping inventory of products (unique IDs)
2. Allowing reservation of Inventory
3. X-ray product for viewing its info

## Important processes
Reservation Process
1. Create a reservation record (status = CREATED)
   --> reservationUid
2. Reserve quantity in inventory
   And add `reservations.{reservationUid}: quantity`
3. update Reservation to status = ACTIVE
4. return the reservationUid

Reservation Process (Serialized)
1. Create a reservation record (status = CREATED)
   --> reservationUid
2. Reserve inventoryItems
   And add `reservationUid: $reservationUid`
3. Reserve quantity in inventory
   And add `reservations.{reservationUid}: quantity`
4. update Reservation to status = ACTIVE
5. return the reservationUid

Cleanup process
1. Pickup reservations (old) with filter (status == CREATED)
2. For each picked up reservation
   1. Update InventoryItems
   	  1. unset reservationUid where `reservationUid = $reservationUid`
   1. Update Inventory
   	  1. unset `reservations.reservationUid` where `reservations.reservationUid = $reservationUid`
	  	  2. increase available quantity
   2. Mark the reservation INVALID

### Periodic Reconcillation Jobs
1. ReleasePartialReservations
   - Description:
   	 Server may crash while ReservingInventory. Thus, any inventory acquired
   	 without fully making an `ACTIVE` reservation, needs to be released.
   - Filter criteria:
   	 status = `CREATED`, createdAt is <old>
2. InvalidateOldReservations
   - Description:
   	 Clears up Active Reservations which were created long ago.
   	 This is needed to ensure, reservations which are not fulfilled
   	 for a long time gets auto-invalidated
   - Filter Criteria:
   	 status = `ACTIVE`, createdAt: <old>
3. RecoverCrashedInvalidations
   - Description:
   	 InvalidateOldReservations may be running when the server crashes.
		 This will cause reservations which were picked up but not fully invalidated
		 to revert back to Active status so that future run of this job can pick
		 them up again.
   - Filter Criteria:
   	 status = `INVALIDATING`, updatedAt: <old>
