DELETE from saved_items;
update raw_data set status = 'pending';

DELETE from saved_items where provider = 'instagram';
update raw_data set status = 'pending' where provider='instagram';


DELETE from saved_items where provider = 'youtube';
update raw_data set status = 'pending' where provider='youtube';