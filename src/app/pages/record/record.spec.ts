import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Record } from './record';

describe('Record', () => {
  let component: Record;
  let fixture: ComponentFixture<Record>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Record],
    }).compileComponents();

    fixture = TestBed.createComponent(Record);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
